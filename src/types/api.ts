export type UpstreamKind = "openai" | "anthropic";
export type UpstreamAuthHeader = "authorization_bearer" | "x-api-key";
export type OpenAIUpstreamMode = "platform" | "codex";
export type UpstreamOperation =
  | "chat_completions"
  | "responses"
  | "response_item"
  | "embeddings"
  | "anthropic_messages"
  | "proxy";

export interface OAuth2Config {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
  /** Appended to the authorize URL (e.g. Codex-style: id_token_add_organizations, originator). */
  authorizeExtraParams?: Record<string, string>;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  tokenType?: string;
  accountId?: string;
}

export interface UpstreamConfig {
  id: string;
  kind: UpstreamKind;
  baseUrl: string;
  openaiMode?: OpenAIUpstreamMode;
  apiKey?: string;
  authMode?: "api_key" | "oauth2";
  authHeader?: UpstreamAuthHeader;
  oauth2?: OAuth2Config;
  enabled?: boolean;
  models?: string[];
  headers?: Record<string, string>;
  cooldownMs?: number;
  timeoutMs?: number;
}

export interface WorkspaceConfig {
  id: string;
  upstreamIds?: string[];
  modelMap?: Record<string, string>;
  enabled?: boolean;
  isDefault?: boolean;
}

/** Pre-fills admin OAuth connector forms when using a self-hosted IdP (e.g. local Codex-like app). */
export interface OAuthConnectDefaults {
  baseUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  authorizeExtraParams?: Record<string, string>;
}

export interface GatewayConfig {
  port: number;
  host: string;
  logLevel: string;
  requestLoggingEnabled: boolean;
  requestTimeoutMs: number;
  dataDir: string;
  gatewayApiKeys: string[];
  /** OAuth redirect path on this gateway (must match IdP registration), e.g. /auth/callback */
  oauthCallbackPath: string;
  /** Full origin for building redirect_uri for generic OAuth connectors. Leave empty for same-origin gateway callback. */
  oauthRedirectOrigin?: string;
  /** Local relay port used by the built-in Codex Team OAuth flow. */
  oauthCallbackPort: number;
  defaultWorkspaceId?: string;
  modelMap: Record<string, string>;
  upstreams: UpstreamConfig[];
  workspaces: WorkspaceConfig[];
  oauthConnectDefaults?: OAuthConnectDefaults;
}

export interface OpenAIChatCompletionRequest {
  model: string;
  stream?: boolean;
  messages?: unknown[];
  [key: string]: unknown;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  stream?: boolean;
  messages: unknown[];
  [key: string]: unknown;
}

export interface UpstreamDispatch {
  upstream: UpstreamConfig;
  workspaceId: string;
  resolvedModel: string;
  response: Response;
}

export interface UpstreamState {
  id: string;
  kind: UpstreamKind;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  networkErrors: number;
  consecutiveFailures: number;
  blockedUntil?: number;
  lastStatus?: number;
  lastError?: string;
  lastRequestAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastOperation?: UpstreamOperation;
  requestCounts: {
    chatCompletions: number;
    responses: number;
    responseItems: number;
    embeddings: number;
    anthropicMessages: number;
    proxy: number;
  };
  latency: {
    samples: number;
    lastMs?: number;
    avgMs?: number;
    maxMs?: number;
  };
  usage: {
    requestsWithUsage: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    lastUpdatedAt?: number;
  };
}

export interface WorkspaceSummary {
  id: string;
  enabled: boolean;
  isDefault: boolean;
  upstreamIds: string[];
  availableModels: string[];
  upstreams: UpstreamState[];
}

export interface PersistedResponseRoute {
  responseId: string;
  upstreamId: string;
  workspaceId: string;
  expiresAt: number;
}

export interface PersistedSessionRoute {
  affinityKey: string;
  upstreamId: string;
  workspaceId: string;
  sessionId?: string;
  promptCacheKey?: string;
  expiresAt: number;
}

export interface PersistedGatewayState {
  upstreams: UpstreamConfig[];
  workspaces: WorkspaceConfig[];
  responseRoutes?: PersistedResponseRoute[];
  sessionRoutes?: PersistedSessionRoute[];
  updatedAt?: string;
}

export interface PendingOAuthConnection {
  setupToken: string;
  upstream: UpstreamConfig;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}
