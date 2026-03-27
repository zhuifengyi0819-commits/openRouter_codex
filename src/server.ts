import { fileURLToPath } from "node:url";

import Fastify from "fastify";

import { loadConfig } from "./config/env.js";
import { GatewayError } from "./core/http-error.js";
import { OAuthCallbackRelay } from "./core/callback-server.js";
import { GatewayRuntime } from "./core/runtime.js";
import { OAuthStateManager } from "./core/oauth-state.js";
import { SecretStore } from "./core/secret-store.js";
import { SetupTokenManager } from "./core/setup-token.js";
import { startTokenRefreshLoop } from "./core/token-refresh.js";
import {
  REQUEST_TRACE_HEADER,
  appendTraceEvent,
  configureRequestLogging,
  ensureRequestTraceId,
  sanitizeHeaders,
  sanitizeValue
} from "./core/request-logs.js";
import { registerOpenAIRoutes } from "./routes/openai.js";
import { registerAnthropicRoutes } from "./routes/anthropic.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerMetaRoutes } from "./routes/meta.js";

function parseGatewayToken(headers: Record<string, unknown>): string | undefined {
  const authorization = headers.authorization;
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }

  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : undefined;
}

function isOpenAIRoute(url: string): boolean {
  return url.startsWith("/v1/") && !url.startsWith("/v1/messages");
}

function mapOpenAIErrorType(statusCode: number): string {
  if (statusCode === 429) {
    return "rate_limit_error";
  }
  if (statusCode >= 500) {
    return "server_error";
  }
  return "invalid_request_error";
}

function sendOpenAIError(
  reply: { code: (statusCode: number) => any; header: (key: string, value: string) => any; type: (value: string) => any; send: (payload: unknown) => any },
  statusCode: number,
  message: string,
  details?: unknown,
  traceId?: string
) {
  const detailObject =
    details && typeof details === "object" && !Array.isArray(details)
      ? details as Record<string, unknown>
      : undefined;

  if (statusCode === 401) {
    reply.header("www-authenticate", 'Bearer realm="OpenAI-Compatible Gateway"');
  }

  const payload = {
    error: {
      message,
      type:
        typeof detailObject?.type === "string"
          ? detailObject.type
          : mapOpenAIErrorType(statusCode),
      param:
        typeof detailObject?.param === "string"
          ? detailObject.param
          : null,
      code:
        typeof detailObject?.code === "string"
          ? detailObject.code
          : null
    }
  };

  void appendTraceEvent(traceId, {
    stage: "gateway.response",
    source: "gateway_error",
    status: statusCode,
    body: payload,
    details: detailObject
  });

  return reply
    .code(statusCode)
    .type("application/json; charset=utf-8")
    .send(payload);
}

export async function buildServer() {
  const config = loadConfig();
  configureRequestLogging(config.requestLoggingEnabled);
  const app = Fastify({
    logger: {
      level: config.logLevel
    },
    requestTimeout: config.requestTimeoutMs
  });

  const secretStore = new SecretStore(config.dataDir);
  const runtime = new GatewayRuntime(config, secretStore);
  const setupTokens = new SetupTokenManager();
  const oauthStates = new OAuthStateManager();
  const codexCallbackRelay = new OAuthCallbackRelay(config.oauthCallbackPort, config.oauthCallbackPath);
  await runtime.initialize();

  startTokenRefreshLoop(runtime, 60_000);

  if (runtime.getConfig().upstreams.length === 0) {
    app.log.warn(
      "No upstreams configured. Open /admin/setup or run `npm run login` to launch the admin page and connect a Team."
    );
  }

  if (config.gatewayApiKeys.length === 0) {
    app.log.warn(
      "No gateway API keys configured. Set GATEWAY_API_KEYS in .env to protect the gateway."
    );
  }

  app.addHook("onRequest", async (request, reply) => {
    const traceId = ensureRequestTraceId(request.headers as Record<string, unknown>);
    reply.header(REQUEST_TRACE_HEADER, traceId);
  });

  app.addHook("preHandler", async (request) => {
    const traceId = ensureRequestTraceId(request.headers as Record<string, unknown>);
    if (!(request as any).__gatewayTraceLogged) {
      (request as any).__gatewayTraceLogged = true;
      void appendTraceEvent(traceId, {
        stage: "incoming.request",
        method: request.method,
        url: request.url,
        routeUrl: request.routeOptions.url ?? null,
        headers: sanitizeHeaders(request.headers as Record<string, unknown>),
        body: sanitizeValue(request.body)
      });
    }

    const routeUrl = request.routeOptions.url ?? "";

    if (
      routeUrl === "/health" ||
      routeUrl === "/ready" ||
      routeUrl === "/admin/setup" ||
      routeUrl === config.oauthCallbackPath ||
      routeUrl.startsWith("/admin/api/")
    ) {
      return;
    }

    if (config.gatewayApiKeys.length === 0) {
      return;
    }

    const token = parseGatewayToken(request.headers as Record<string, unknown>);
    if (!token || !config.gatewayApiKeys.includes(token)) {
      void appendTraceEvent(traceId, {
        stage: "gateway.auth_failed",
        reason: "invalid_api_key"
      });
      throw new GatewayError(401, "Invalid API key provided", {
        code: "invalid_api_key",
        type: "invalid_request_error"
      });
    }
  });

  app.get("/health", async () => ({
    ok: runtime.getConfig().upstreams.length > 0,
    configuredUpstreams: runtime.getConfig().upstreams.length,
    configuredWorkspaces: runtime.getConfig().workspaces.length,
    message:
      runtime.getConfig().upstreams.length > 0
        ? "Gateway is ready"
        : "Gateway started without upstreams. Run `npm run login` to open admin and connect a Team.",
    runtime: runtime.getRuntimeSummary()
  }));

  app.get("/ready", async () => {
    const summary = runtime.getRuntimeSummary();
    const ready = summary.configuredUpstreams > 0 && summary.scheduler.some((upstream) => upstream.blockedUntil === undefined);
    return {
      ok: ready,
      configuredUpstreams: summary.configuredUpstreams,
      activeUpstreams: summary.scheduler.filter((upstream) => upstream.blockedUntil === undefined).length,
      blockedUpstreams: summary.scheduler.filter((upstream) => upstream.blockedUntil !== undefined).length
    };
  });

  await registerAdminRoutes(app, { runtime, setupTokens, oauthStates, codexCallbackRelay });
  await registerMetaRoutes(app, { runtime });
  await registerOpenAIRoutes(app, { runtime });
  await registerAnthropicRoutes(app, { runtime });

  app.setNotFoundHandler((request, reply) => {
    const traceId = ensureRequestTraceId(request.headers as Record<string, unknown>);
    void appendTraceEvent(traceId, {
      stage: "gateway.not_found",
      method: request.method,
      url: request.url
    });
    if (isOpenAIRoute(request.url)) {
      return sendOpenAIError(reply, 404, `Invalid URL (${request.method} ${request.url})`, undefined, traceId);
    }

    return reply.code(404).send({
      error: "NotFound",
      message: `Route ${request.method}:${request.url} not found`
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const traceId = ensureRequestTraceId(request.headers as Record<string, unknown>);
    if ((error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") {
      return reply.code(499).send();
    }

    if (isOpenAIRoute(request.url)) {
      if (error instanceof GatewayError) {
        return sendOpenAIError(reply, error.statusCode, error.message, error.details, traceId);
      }

      request.log.error(error);
      return sendOpenAIError(
        reply,
        500,
        "The server had an error while processing your request.",
        undefined,
        traceId
      );
    }

    if (error instanceof GatewayError) {
      return reply.code(error.statusCode).send({
        error: error.name,
        message: error.message,
        details: error.details
      });
    }

    request.log.error(error);
    return reply.code(500).send({
      error: "InternalServerError",
      message: "Unexpected server error"
    });
  });

  return { app, config, runtime, setupTokens, oauthStates, codexCallbackRelay };
}

const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const { app, config, runtime } = await buildServer();

  try {
    await app.listen({ host: config.host, port: config.port });

    const upstreams = runtime.getConfig().upstreams;
    console.log(`\n=== Compatible LLM Gateway ===`);
    console.log(`Listening on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
    console.log(`Upstreams: ${upstreams.length}`);
    for (const u of upstreams) {
      const org = u.headers?.["OpenAI-Organization"] ?? "-";
      console.log(`  [${u.id}] kind=${u.kind} base=${u.baseUrl} org=${org} auth=${u.authMode ?? "api_key"}`);
    }
    console.log(`\nOpenAI-compatible endpoints:`);
    console.log(`  POST /v1/chat/completions`);
    console.log(`  POST /v1/responses`);
    console.log(`  POST /v1/embeddings`);
    console.log(`  GET  /v1/models`);
    console.log(`  GET  /v1/models/:id`);
    console.log(`\nAnthropic-compatible:`);
    console.log(`  POST /v1/messages`);
    console.log(`\nGateway diagnostics:`);
    console.log(`  GET  /v1/gateway/usage`);
    console.log(`Request trace logs: ${config.requestLoggingEnabled ? "enabled" : "disabled"}`);
    console.log(`\nGateway token: Authorization: Bearer <GATEWAY_API_KEYS>`);
    console.log(`====================\n`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
