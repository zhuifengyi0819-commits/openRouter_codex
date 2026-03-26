import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayConfig } from "../types/api.js";

import { renderAdminPage } from "../admin/page.js";
import {
  buildCodexAuthorizeExtraParams,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_SCOPES,
  CODEX_OAUTH_TOKEN_URL
} from "../core/codex-oauth.js";
import type { OAuthCallbackRelay } from "../core/callback-server.js";
import { GatewayError } from "../core/http-error.js";
import type { OAuthStateManager } from "../core/oauth-state.js";
import { DEFAULT_CODEX_BASE_URL, DEFAULT_CODEX_MODELS } from "../core/openai-upstream.js";
import type { GatewayRuntime } from "../core/runtime.js";
import type { SetupTokenManager } from "../core/setup-token.js";
import type { UpstreamConfig, WorkspaceConfig } from "../types/api.js";

interface RouteDeps {
  runtime: GatewayRuntime;
  setupTokens: SetupTokenManager;
  oauthStates: OAuthStateManager;
  codexCallbackRelay: OAuthCallbackRelay;
}

function redactValue(value: string | undefined): string | undefined {
  return value ? "[redacted]" : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    redacted[key] =
      normalized === "authorization" || normalized === "x-api-key" || normalized === "cookie"
        ? "[redacted]"
        : value;
  }

  return redacted;
}

function redactUpstream(upstream: UpstreamConfig): UpstreamConfig {
  return {
    ...upstream,
    apiKey: redactValue(upstream.apiKey),
    headers: redactHeaders(upstream.headers),
    oauth2: upstream.oauth2
      ? {
          ...upstream.oauth2,
          clientSecret: redactValue(upstream.oauth2.clientSecret) ?? "",
          accessToken: redactValue(upstream.oauth2.accessToken) ?? "",
          refreshToken: redactValue(upstream.oauth2.refreshToken)
        }
      : undefined
  };
}

function extractSetupToken(headers: Record<string, unknown>, query: Record<string, unknown>): string | undefined {
  const headerToken = headers["x-setup-token"];
  if (typeof headerToken === "string") {
    return headerToken;
  }

  const queryToken = query.setupToken;
  return typeof queryToken === "string" ? queryToken : undefined;
}

function requireSetupToken(
  setupTokens: SetupTokenManager,
  headers: Record<string, unknown>,
  query: Record<string, unknown>
): string {
  const token = extractSetupToken(headers, query);
  if (!setupTokens.isValid(token)) {
    throw new GatewayError(401, "Invalid or expired setup token");
  }

  return token!;
}

function getOrigin(request: {
  headers: Record<string, unknown>;
}): string {
  const protoHeader = request.headers["x-forwarded-proto"];
  const hostHeader = request.headers["x-forwarded-host"] ?? request.headers.host;
  const proto = typeof protoHeader === "string" ? protoHeader : "http";
  const host = typeof hostHeader === "string" ? hostHeader : "127.0.0.1:3000";
  return `${proto}://${host}`;
}

function resolveOAuthCallbackOrigin(
  gatewayConfig: GatewayConfig,
  request: {
    headers: Record<string, unknown>;
  },
  logger?: { warn: (message: string) => void }
): string {
  const requestOrigin = getOrigin(request);
  const configuredOrigin = gatewayConfig.oauthRedirectOrigin?.trim();
  if (!configuredOrigin) {
    return requestOrigin;
  }

  try {
    return new URL(configuredOrigin).origin;
  } catch {
    logger?.warn(`Ignoring invalid OAUTH_REDIRECT_ORIGIN="${configuredOrigin}" for admin OAuth. Using request origin instead.`);
    return requestOrigin;
  }
}

function renderOAuthResultPage(message: string, setupToken: string, isError = false): string {
  const safeMessage = escapeHtml(message);
  const safeSetupToken = encodeURIComponent(setupToken);
  const messageForScript = JSON.stringify(message).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OAuth Result</title>
    <style>
      body { margin: 0; font-family: "Iowan Old Style", "Palatino Linotype", serif; background: #f6f3ee; color: #1f1b16; }
      main { max-width: 720px; margin: 48px auto; padding: 24px; }
      article { background: #fffdf8; border: 1px solid #d8cec1; border-radius: 16px; padding: 24px; }
      a { color: #0f766e; }
      .error { color: #b45309; }
    </style>
  </head>
  <body>
    <main>
      <article>
        <h1>${isError ? "OAuth Failed" : "OAuth Connected"}</h1>
        <p class="${isError ? "error" : ""}">${safeMessage}</p>
        <p><a href="/admin/setup?setupToken=${safeSetupToken}">Return to Gateway Admin</a></p>
      </article>
    </main>
    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(
            {
              type: "gateway:oauth-complete",
              ok: ${isError ? "false" : "true"},
              message: ${messageForScript}
            },
            window.location.origin
          );
        }
      } catch {}
    </script>
  </body>
</html>`;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/admin/setup", async (request, reply) => {
    const token = requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    reply.type("text/html; charset=utf-8");
    return renderAdminPage(deps.runtime, token);
  });

  app.get("/admin/api/state", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    return {
      config: {
        ...deps.runtime.getConfig(),
        gatewayApiKeys: deps.runtime.getConfig().gatewayApiKeys.map(() => "[redacted]"),
        upstreams: deps.runtime.getConfig().upstreams.map(redactUpstream)
      },
      persistedState: {
        ...deps.runtime.getPersistedState(),
        upstreams: deps.runtime.getPersistedState().upstreams.map(redactUpstream)
      },
      storage: {
        dataDir: deps.runtime.getStoragePaths().dataDir,
        statePath: deps.runtime.getStoragePaths().statePath
      },
      workspaces: deps.runtime.getGateway().getWorkspaceSummaries(),
      runtime: deps.runtime.getRuntimeSummary()
    };
  });

  app.get("/admin/api/runtime", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    return deps.runtime.getRuntimeSummary();
  });

  app.get("/admin/api/connectors", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    return {
      object: "list",
      data: [
        {
          id: "openai-api-key",
          label: "OpenAI-Compatible",
          auth: "api_key",
          kind: "openai",
          official: true,
          description: "Connect an OpenAI-compatible API using an API key. OpenAI official API currently uses API keys."
        },
        {
          id: "anthropic-api-key",
          label: "Anthropic-Compatible",
          auth: "api_key",
          kind: "anthropic",
          official: true,
          description: "Connect an Anthropic-compatible API using an API key. Anthropic official API currently uses API keys."
        },
        {
          id: "oauth-openai-compatible",
          label: "OAuth OpenAI-Compatible (Non-Codex)",
          auth: "oauth2",
          kind: "openai",
          official: false,
          description: "For providers that officially support OAuth2 and expose a standard OpenAI-compatible API. ChatGPT/Codex subscription accounts should use the Connect Codex Team button in admin."
        },
        {
          id: "oauth-anthropic-compatible",
          label: "OAuth Anthropic-Compatible",
          auth: "oauth2",
          kind: "anthropic",
          official: false,
          description: "For providers that officially support OAuth2 and expose an Anthropic-compatible API shape."
        }
      ]
    };
  });

  app.post<{ Body: UpstreamConfig }>("/admin/api/upstreams", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    await deps.runtime.upsertUpstream(request.body);

    return {
      ok: true,
      upstreams: deps.runtime.getConfig().upstreams.map((item) => item.id)
    };
  });

  app.post("/admin/api/connectors/codex/start", async (request) => {
    const setupToken = requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    const gatewayConfig = deps.runtime.getConfig();
    const adminOrigin = getOrigin(request as { headers: Record<string, unknown> });
    let redirectUri: string;
    try {
      redirectUri = await deps.codexCallbackRelay.ensureStarted(adminOrigin);
    } catch (error) {
      throw new GatewayError(
        502,
        `Failed to start local OAuth callback relay on port ${gatewayConfig.oauthCallbackPort}. Make sure localhost:${gatewayConfig.oauthCallbackPort} is available.`,
        { message: (error as Error).message }
      );
    }
    const forceLoginPrompt = gatewayConfig.upstreams.some((upstream) => upstream.authMode === "oauth2");

    const upstream: UpstreamConfig = {
      id: `codex-${Date.now()}`,
      kind: "openai",
      baseUrl: DEFAULT_CODEX_BASE_URL,
      openaiMode: "codex",
      authMode: "oauth2",
      authHeader: "authorization_bearer",
      enabled: true,
      models: [...DEFAULT_CODEX_MODELS],
      oauth2: {
        authorizationUrl: CODEX_OAUTH_AUTHORIZE_URL,
        tokenUrl: CODEX_OAUTH_TOKEN_URL,
        clientId: CODEX_OAUTH_CLIENT_ID,
        clientSecret: "",
        scopes: [...CODEX_OAUTH_SCOPES],
        authorizeExtraParams: buildCodexAuthorizeExtraParams(forceLoginPrompt),
        accessToken: ""
      }
    };

    const { authorizationUrl } = deps.oauthStates.create({
      setupToken,
      upstream,
      redirectUri
    });

    return {
      ok: true,
      authorizationUrl,
      forceLoginPrompt
    };
  });

  app.post<{ Body: UpstreamConfig }>("/admin/api/connectors/oauth/start", async (request) => {
    const setupToken = requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    const upstreamBody = {
      ...request.body,
      authMode: "oauth2" as const
    };

    let normalized = await deps.runtime.previewUpstream(upstreamBody);
    if (!normalized.oauth2) {
      throw new GatewayError(400, "OAuth connector requires oauth2 settings");
    }

    const gatewayConfig = deps.runtime.getConfig();
    const defaults = gatewayConfig.oauthConnectDefaults;
    const extraFromDefaults = defaults?.authorizeExtraParams ?? {};
    const extraFromBody = normalized.oauth2.authorizeExtraParams ?? {};
    normalized = {
      ...normalized,
      oauth2: {
        ...normalized.oauth2,
        authorizeExtraParams: { ...extraFromDefaults, ...extraFromBody }
      }
    };

    const callbackOrigin = resolveOAuthCallbackOrigin(
      gatewayConfig,
      request as { headers: Record<string, unknown> },
      app.log
    );
    const redirectUri = `${callbackOrigin}${gatewayConfig.oauthCallbackPath}`;
    const { authorizationUrl } = deps.oauthStates.create({
      setupToken,
      upstream: normalized,
      redirectUri
    });

    return {
      ok: true,
      authorizationUrl
    };
  });

  const handleOAuthCallback = async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, unknown>;
    const state = typeof query.state === "string" ? query.state : undefined;
    const code = typeof query.code === "string" ? query.code : undefined;
    const error = typeof query.error === "string" ? query.error : undefined;

    const pending = state ? deps.oauthStates.consume(state) : undefined;
    if (!pending) {
      reply.type("text/html; charset=utf-8");
      return renderOAuthResultPage("Missing or expired OAuth state.", "", true);
    }

    if (error) {
      reply.type("text/html; charset=utf-8");
      return renderOAuthResultPage(`Provider returned error: ${error}`, pending.setupToken, true);
    }

    if (!code) {
      reply.type("text/html; charset=utf-8");
      return renderOAuthResultPage("Provider callback did not include an authorization code.", pending.setupToken, true);
    }

    try {
      const upstream = await deps.runtime.completeOAuthConnection(pending, code);
      reply.type("text/html; charset=utf-8");
      return renderOAuthResultPage(`Connected upstream "${upstream.id}".`, pending.setupToken);
    } catch (oauthError) {
      reply.type("text/html; charset=utf-8");
      return renderOAuthResultPage((oauthError as Error).message, pending.setupToken, true);
    }
  };

  app.get(deps.runtime.getConfig().oauthCallbackPath, handleOAuthCallback);

  app.post<{ Body: WorkspaceConfig }>("/admin/api/workspaces", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    await deps.runtime.upsertWorkspace(request.body);

    return {
      ok: true,
      workspaces: deps.runtime.getConfig().workspaces.map((item) => item.id)
    };
  });

  app.post<{ Params: { id: string }; Body: Partial<UpstreamConfig> & { oauth2?: Record<string, unknown> } }>(
    "/admin/api/upstreams/:id/edit",
    async (request) => {
      requireSetupToken(
        deps.setupTokens,
        request.headers as Record<string, unknown>,
        request.query as Record<string, unknown>
      );

      await deps.runtime.updateUpstream(request.params.id, request.body as any);

      return {
        ok: true,
        upstreamId: request.params.id
      };
    }
  );

  app.post<{ Params: { id: string }; Body: Partial<WorkspaceConfig> }>(
    "/admin/api/workspaces/:id/edit",
    async (request) => {
      requireSetupToken(
        deps.setupTokens,
        request.headers as Record<string, unknown>,
        request.query as Record<string, unknown>
      );

      await deps.runtime.updateWorkspace(request.params.id, request.body);

      return {
        ok: true,
        workspaceId: request.params.id
      };
    }
  );

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/admin/api/upstreams/:id/enabled",
    async (request) => {
      requireSetupToken(
        deps.setupTokens,
        request.headers as Record<string, unknown>,
        request.query as Record<string, unknown>
      );

      await deps.runtime.setUpstreamEnabled(request.params.id, request.body.enabled);

      return {
        ok: true,
        upstreamId: request.params.id,
        enabled: request.body.enabled
      };
    }
  );

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/admin/api/workspaces/:id/enabled",
    async (request) => {
      requireSetupToken(
        deps.setupTokens,
        request.headers as Record<string, unknown>,
        request.query as Record<string, unknown>
      );

      await deps.runtime.setWorkspaceEnabled(request.params.id, request.body.enabled);

      return {
        ok: true,
        workspaceId: request.params.id,
        enabled: request.body.enabled
      };
    }
  );

  app.delete<{ Params: { id: string } }>("/admin/api/upstreams/:id", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    await deps.runtime.deleteUpstream(request.params.id);

    return {
      ok: true,
      upstreamId: request.params.id
    };
  });

  app.delete<{ Params: { id: string } }>("/admin/api/workspaces/:id", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    await deps.runtime.deleteWorkspace(request.params.id);

    return {
      ok: true,
      workspaceId: request.params.id
    };
  });

  app.post<{ Params: { id: string } }>("/admin/api/upstreams/:id/refresh-models", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    const models = await deps.runtime.refreshUpstreamModels(request.params.id);
    return {
      ok: true,
      upstreamId: request.params.id,
      models
    };
  });

  app.post<{ Params: { id: string } }>("/admin/api/upstreams/:id/check", async (request) => {
    requireSetupToken(
      deps.setupTokens,
      request.headers as Record<string, unknown>,
      request.query as Record<string, unknown>
    );

    return deps.runtime.checkUpstreamHealth(request.params.id);
  });
}
