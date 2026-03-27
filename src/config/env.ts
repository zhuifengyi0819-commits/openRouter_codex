import "dotenv/config";

import path from "node:path";

import type { GatewayConfig, OAuthConnectDefaults, UpstreamConfig, WorkspaceConfig } from "../types/api.js";
import { getOpenAIUpstreamMode } from "../core/openai-upstream.js";

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer but received "${value}"`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected boolean but received "${value}"`);
}

function parseJson<T>(value: string | undefined, fallback: T, label: string): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${(error as Error).message}`);
  }
}

function normalizeUpstream(config: UpstreamConfig, defaultTimeoutMs: number): UpstreamConfig {
  if (!config.id) {
    throw new Error("Each upstream requires a non-empty id");
  }

  if (!config.baseUrl) {
    throw new Error(`Upstream "${config.id}" requires baseUrl`);
  }

  const authMode = config.authMode ?? "api_key";
  if (authMode === "api_key" && !config.apiKey) {
    throw new Error(`Upstream "${config.id}" requires apiKey`);
  }

  if (authMode === "oauth2") {
    if (!config.oauth2?.accessToken) {
      throw new Error(`Upstream "${config.id}" requires oauth2.accessToken`);
    }
    if (!config.oauth2.authorizationUrl || !config.oauth2.tokenUrl || !config.oauth2.clientId || !config.oauth2.clientSecret) {
      throw new Error(`Upstream "${config.id}" requires oauth2 authorizationUrl, tokenUrl, clientId, and clientSecret`);
    }
  }

  return {
    ...config,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    openaiMode: config.kind === "openai" ? getOpenAIUpstreamMode(config) : undefined,
    authMode,
    authHeader: config.authHeader ?? (config.kind === "anthropic" ? "x-api-key" : "authorization_bearer"),
    enabled: config.enabled ?? true,
    cooldownMs: config.cooldownMs ?? 30_000,
    timeoutMs: config.timeoutMs ?? defaultTimeoutMs
  };
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trimTrailingSlashes(origin: string): string {
  return origin.replace(/\/+$/, "");
}

function joinOriginAndPath(origin: string, path: string): string {
  const base = trimTrailingSlashes(origin);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

function loadAuthorizeExtraParams(): Record<string, string> | undefined {
  const raw = process.env.OAUTH_CONNECT_AUTHORIZE_EXTRA_JSON?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = parseJson<Record<string, unknown>>(raw, {}, "OAUTH_CONNECT_AUTHORIZE_EXTRA_JSON");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) {
      continue;
    }
    out[key] = typeof value === "string" ? value : String(value);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function loadOauthConnectDefaults(): OAuthConnectDefaults | undefined {
  const rawOrigin = process.env.OAUTH_CONNECT_PROVIDER_ORIGIN?.trim();
  if (!rawOrigin) {
    return undefined;
  }

  const origin = trimTrailingSlashes(rawOrigin);
  const authorizePath = process.env.OAUTH_CONNECT_AUTHORIZE_PATH?.trim() || "/authorize";
  const tokenPath = process.env.OAUTH_CONNECT_TOKEN_PATH?.trim() || "/token";
  const apiBaseRaw = process.env.OAUTH_CONNECT_API_BASE_URL?.trim();
  const apiBase = apiBaseRaw ? trimTrailingSlashes(apiBaseRaw) : origin;
  const authorizeExtraParams = loadAuthorizeExtraParams();

  return {
    baseUrl: apiBase,
    authorizationUrl: joinOriginAndPath(origin, authorizePath),
    tokenUrl: joinOriginAndPath(origin, tokenPath),
    ...(authorizeExtraParams ? { authorizeExtraParams } : {})
  };
}

function normalizeOauthCallbackPath(raw: string | undefined): string {
  const trimmed = raw?.trim();
  const path = (trimmed && trimmed.length > 0 ? trimmed : "/admin/oauth/callback").replace(/\/+$/, "");
  if (!path.startsWith("/")) {
    throw new Error('OAUTH_CALLBACK_PATH must start with "/"');
  }
  return path.length > 0 ? path : "/admin/oauth/callback";
}

export function normalizeWorkspaces(
  workspaces: WorkspaceConfig[],
  upstreams: UpstreamConfig[]
): { defaultWorkspaceId?: string; workspaces: WorkspaceConfig[] } {
  if (workspaces.length === 0) {
    if (upstreams.length === 0) {
      return {
        defaultWorkspaceId: undefined,
        workspaces: []
      };
    }

    return {
      defaultWorkspaceId: "default",
      workspaces: [
        {
          id: "default",
          upstreamIds: upstreams.map((upstream) => upstream.id),
          modelMap: {},
          enabled: true,
          isDefault: true
        }
      ]
    };
  }

  const upstreamIds = new Set(upstreams.map((upstream) => upstream.id));
  const seenWorkspaceIds = new Set<string>();
  let defaultWorkspaceId: string | undefined;

  const normalized = workspaces.map((workspace, index) => {
    if (!workspace.id) {
      throw new Error("Each workspace requires a non-empty id");
    }

    if (seenWorkspaceIds.has(workspace.id)) {
      throw new Error(`Duplicate workspace id "${workspace.id}"`);
    }
    seenWorkspaceIds.add(workspace.id);

    const effectiveUpstreamIds = workspace.upstreamIds ?? upstreams.map((upstream) => upstream.id);
    for (const upstreamId of effectiveUpstreamIds) {
      if (!upstreamIds.has(upstreamId)) {
        throw new Error(`Workspace "${workspace.id}" references unknown upstream "${upstreamId}"`);
      }
    }

    const isDefault = workspace.isDefault === true;
    if (isDefault) {
      if (defaultWorkspaceId) {
        throw new Error("Only one workspace can be marked as default");
      }
      defaultWorkspaceId = workspace.id;
    }

    return {
      ...workspace,
      upstreamIds: effectiveUpstreamIds,
      modelMap: workspace.modelMap ?? {},
      enabled: workspace.enabled ?? true,
      isDefault
    };
  });

  if (!defaultWorkspaceId && normalized.length > 0) {
    normalized[0]!.isDefault = true;
    defaultWorkspaceId = normalized[0]!.id;
  }

  return {
    defaultWorkspaceId,
    workspaces: normalized
  };
}

export function loadConfig(): GatewayConfig {
  const requestTimeoutMs = parseInteger(process.env.REQUEST_TIMEOUT_MS, 120_000);
  const rawUpstreams = parseJson<UpstreamConfig[]>(process.env.UPSTREAMS_JSON, [], "UPSTREAMS_JSON");
  const rawWorkspaces = parseJson<WorkspaceConfig[]>(process.env.WORKSPACES_JSON, [], "WORKSPACES_JSON");
  const modelMap = parseJson<Record<string, string>>(process.env.MODEL_MAP_JSON, {}, "MODEL_MAP_JSON");
  const upstreams = rawUpstreams.map((item) => normalizeUpstream(item, requestTimeoutMs));
  const normalizedWorkspaces = normalizeWorkspaces(rawWorkspaces, upstreams);

  return {
    port: parseInteger(process.env.PORT, 3000),
    host: process.env.HOST ?? "0.0.0.0",
    logLevel: process.env.LOG_LEVEL ?? "info",
    requestLoggingEnabled: parseBoolean(process.env.REQUEST_LOGGING_ENABLED, false),
    requestTimeoutMs,
    dataDir: path.resolve(process.cwd(), process.env.DATA_DIR ?? ".gateway-data"),
    gatewayApiKeys: parseList(process.env.GATEWAY_API_KEYS),
    oauthCallbackPath: normalizeOauthCallbackPath(process.env.OAUTH_CALLBACK_PATH),
    oauthRedirectOrigin: process.env.OAUTH_REDIRECT_ORIGIN?.trim() || undefined,
    oauthCallbackPort: parseInteger(process.env.OAUTH_CALLBACK_PORT, 1455),
    defaultWorkspaceId: normalizedWorkspaces.defaultWorkspaceId,
    modelMap,
    upstreams,
    workspaces: normalizedWorkspaces.workspaces,
    oauthConnectDefaults: loadOauthConnectDefaults()
  };
}
