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

export async function buildServer() {
  const config = loadConfig();
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

  app.addHook("preHandler", async (request) => {
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
      throw new GatewayError(401, "Invalid gateway API key");
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

  app.setErrorHandler((error, request, reply) => {
    if ((error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") {
      return reply.code(499).send();
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
    console.log(`\nGateway token: Authorization: Bearer <GATEWAY_API_KEYS>`);
    console.log(`====================\n`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
