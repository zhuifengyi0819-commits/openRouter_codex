import type { UpstreamConfig } from "../types/api.js";
import { getUpstreamSecret } from "./upstream-auth.js";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_CODEX_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex"
];

export function getOpenAIUpstreamMode(upstream: UpstreamConfig): "platform" | "codex" {
  if (upstream.kind !== "openai") {
    return "platform";
  }

  return upstream.openaiMode ?? "platform";
}

export function isCodexUpstream(upstream: UpstreamConfig): boolean {
  return upstream.kind === "openai" && getOpenAIUpstreamMode(upstream) === "codex";
}

export function extractChatGPTAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split(".");
    if (parts.length < 2) {
      return undefined;
    }

    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
    const auth = payload["https://api.openai.com/auth"];
    return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

export function getCodexAccountId(upstream: UpstreamConfig): string {
  const accountId = upstream.oauth2?.accountId ?? extractChatGPTAccountId(getUpstreamSecret(upstream));
  if (!accountId) {
    throw new Error(`Upstream "${upstream.id}" is missing chatgpt account id`);
  }

  return accountId;
}

export function buildCodexHeaders(
  upstream: UpstreamConfig,
  init: Record<string, string> = {},
  options: {
    accept?: string;
    sessionId?: string;
  } = {}
): Headers {
  const headers = new Headers({
    ...upstream.headers,
    ...init
  });
  headers.set("authorization", `Bearer ${getUpstreamSecret(upstream)}`);
  headers.set("chatgpt-account-id", getCodexAccountId(upstream));
  headers.set("originator", "pi");
  headers.set("user-agent", "compatible-llm-gateway");
  if (options.accept) {
    headers.set("accept", options.accept);
  }
  if (options.sessionId) {
    headers.set("session_id", options.sessionId);
  }
  return headers;
}

export function resolveCodexResponsesUrl(baseUrl: string): string {
  const normalized = (baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`;
  }
  return `${normalized}/codex/responses`;
}

export function resolveCodexProxyUrl(baseUrl: string, path: string): string {
  const base = resolveCodexResponsesUrl(baseUrl);
  if (path === "/v1/responses") {
    return base;
  }
  if (path.startsWith("/v1/responses/")) {
    return `${base}/${path.slice("/v1/responses/".length)}`;
  }

  throw new Error(`Unsupported Codex proxy path: ${path}`);
}
