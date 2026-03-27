import type { IncomingHttpHeaders } from "node:http";

import type { OpenAIChatCompletionRequest, UpstreamConfig } from "../types/api.js";
import { isCodexUpstream } from "../core/openai-upstream.js";
import {
  appendTraceEvent,
  getRequestTraceId,
  logResponseSnapshot,
  sanitizeHeaders,
  sanitizeValue
} from "../core/request-logs.js";
import { buildAuthHeaders } from "../core/upstream-auth.js";
import { OpenAICodexProvider } from "./openai-codex.provider.js";

interface OpenAIRequestAffinityOptions {
  sessionId?: string;
  promptCacheKey?: string;
  traceId?: string;
}

function appendIfPresent(headers: Headers, source: IncomingHttpHeaders, key: string): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    headers.set(key, value);
  }
}

function appendAllowlistedRequestHeaders(headers: Headers, source: IncomingHttpHeaders): void {
  for (const key of [
    "openai-organization",
    "openai-project",
    "openai-beta",
    "idempotency-key"
  ]) {
    appendIfPresent(headers, source, key);
  }
}

function redactHeaderValue(key: string, value: string): string {
  const normalized = key.toLowerCase();
  if (
    normalized === "authorization" ||
    normalized === "x-api-key" ||
    normalized === "cookie" ||
    normalized === "set-cookie" ||
    normalized === "proxy-authorization"
  ) {
    return "[redacted]";
  }

  return value;
}

function buildUpstreamHeaders(upstream: UpstreamConfig, requestHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    ...buildAuthHeaders(upstream, "authorization_bearer"),
    ...upstream.headers
  });
  appendAllowlistedRequestHeaders(headers, requestHeaders);
  if (upstream.authMode === "oauth2") {
    headers.delete("openai-organization");
  }
  return headers;
}

function logRequest(method: string, url: string, headers: Headers, extra?: string): void {
  const h: Record<string, string> = {};
  headers.forEach((v, k) => { h[k] = redactHeaderValue(k, v); });
  console.log(`[openai] ${method} ${url}`);
  console.log(`[openai] headers=${JSON.stringify(h)}`);
  if (extra) console.log(`[openai] ${extra}`);
}

export class OpenAIProvider {
  private readonly codexProvider = new OpenAICodexProvider();

  public async createChatCompletion(
    upstream: UpstreamConfig,
    payload: OpenAIChatCompletionRequest,
    requestHeaders: IncomingHttpHeaders,
    options?: OpenAIRequestAffinityOptions
  ): Promise<Response> {
    const traceId = options?.traceId ?? getRequestTraceId(requestHeaders);
    if (isCodexUpstream(upstream)) {
      return this.codexProvider.createChatCompletion(upstream, payload, options);
    }

    const headers = buildUpstreamHeaders(upstream, requestHeaders);
    const url = `${upstream.baseUrl}/v1/chat/completions`;
    logRequest("POST", url, headers, `model=${payload.model} stream=${payload.stream ?? false}`);
    void appendTraceEvent(traceId, {
      stage: "upstream.request",
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "chat_completions",
      method: "POST",
      url,
      headers: sanitizeHeaders(headers),
      body: sanitizeValue(payload)
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });
    logResponseSnapshot(traceId, "upstream.response", response, {
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "chat_completions",
      url
    });
    return response;
  }

  public async createResponse(
    upstream: UpstreamConfig,
    payload: Record<string, unknown>,
    requestHeaders: IncomingHttpHeaders,
    options?: OpenAIRequestAffinityOptions
  ): Promise<Response> {
    const traceId = options?.traceId ?? getRequestTraceId(requestHeaders);
    if (isCodexUpstream(upstream)) {
      return this.codexProvider.createResponse(upstream, payload, options);
    }

    const headers = buildUpstreamHeaders(upstream, requestHeaders);
    const url = `${upstream.baseUrl}/v1/responses`;
    logRequest("POST", url, headers, `model=${payload.model ?? "?"} stream=${payload.stream ?? false}`);
    void appendTraceEvent(traceId, {
      stage: "upstream.request",
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "responses",
      method: "POST",
      url,
      headers: sanitizeHeaders(headers),
      body: sanitizeValue(payload)
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });
    logResponseSnapshot(traceId, "upstream.response", response, {
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "responses",
      url
    });
    return response;
  }

  public async createEmbedding(
    upstream: UpstreamConfig,
    payload: Record<string, unknown>,
    requestHeaders: IncomingHttpHeaders
  ): Promise<Response> {
    const traceId = getRequestTraceId(requestHeaders);
    const headers = buildUpstreamHeaders(upstream, requestHeaders);
    const url = `${upstream.baseUrl}/v1/embeddings`;
    logRequest("POST", url, headers, `model=${payload.model ?? "?"}`);
    void appendTraceEvent(traceId, {
      stage: "upstream.request",
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "embeddings",
      method: "POST",
      url,
      headers: sanitizeHeaders(headers),
      body: sanitizeValue(payload)
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });
    logResponseSnapshot(traceId, "upstream.response", response, {
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "embeddings",
      url
    });
    return response;
  }

  public async listModels(
    upstream: UpstreamConfig,
    requestHeaders: IncomingHttpHeaders
  ): Promise<Response> {
    const traceId = getRequestTraceId(requestHeaders);
    if (isCodexUpstream(upstream)) {
      const response = new Response(JSON.stringify({
        object: "list",
        data: (upstream.models ?? []).map((id) => ({
          id,
          object: "model",
          owned_by: upstream.id
        }))
      }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8"
        }
      });
      logResponseSnapshot(traceId, "upstream.response", response, {
        provider: "openai",
        upstreamId: upstream.id,
        upstreamMode: "codex",
        operation: "models",
        synthetic: true
      });
      return response;
    }

    const headers = buildUpstreamHeaders(upstream, requestHeaders);
    const url = `${upstream.baseUrl}/v1/models`;
    logRequest("GET", url, headers);
    void appendTraceEvent(traceId, {
      stage: "upstream.request",
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "models",
      method: "GET",
      url,
      headers: sanitizeHeaders(headers)
    });

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 30_000)
    });
    logResponseSnapshot(traceId, "upstream.response", response, {
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "models",
      url
    });
    return response;
  }

  public async getModel(
    upstream: UpstreamConfig,
    modelId: string,
    requestHeaders: IncomingHttpHeaders
  ): Promise<Response> {
    const traceId = getRequestTraceId(requestHeaders);
    if (isCodexUpstream(upstream)) {
      const exists = (upstream.models ?? []).includes(modelId);
      const response = new Response(JSON.stringify(
        exists
          ? { id: modelId, object: "model", owned_by: upstream.id }
          : { error: { message: `Unknown model "${modelId}"` } }
      ), {
        status: exists ? 200 : 404,
        headers: {
          "content-type": "application/json; charset=utf-8"
        }
      });
      logResponseSnapshot(traceId, "upstream.response", response, {
        provider: "openai",
        upstreamId: upstream.id,
        upstreamMode: "codex",
        operation: "model",
        synthetic: true,
        modelId
      });
      return response;
    }

    const headers = buildUpstreamHeaders(upstream, requestHeaders);
    const url = `${upstream.baseUrl}/v1/models/${encodeURIComponent(modelId)}`;
    logRequest("GET", url, headers);
    void appendTraceEvent(traceId, {
      stage: "upstream.request",
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "model",
      method: "GET",
      url,
      headers: sanitizeHeaders(headers),
      modelId
    });

    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 30_000)
    });
    logResponseSnapshot(traceId, "upstream.response", response, {
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "model",
      url,
      modelId
    });
    return response;
  }

  public async proxy(
    upstream: UpstreamConfig,
    method: string,
    path: string,
    requestHeaders: IncomingHttpHeaders,
    body?: string
  ): Promise<Response> {
    const traceId = getRequestTraceId(requestHeaders);
    if (isCodexUpstream(upstream)) {
      return this.codexProvider.proxy(upstream, method, path, body, traceId);
    }

    const headers = buildUpstreamHeaders(upstream, requestHeaders);
    const url = `${upstream.baseUrl}${path}`;
    logRequest(method, url, headers);
    void appendTraceEvent(traceId, {
      stage: "upstream.request",
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "proxy",
      method,
      url,
      headers: sanitizeHeaders(headers),
      body: sanitizeValue(body)
    });

    const response = await fetch(url, {
      method,
      headers,
      body: method !== "GET" && method !== "HEAD" ? body : undefined,
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });
    logResponseSnapshot(traceId, "upstream.response", response, {
      provider: "openai",
      upstreamId: upstream.id,
      upstreamMode: "platform",
      operation: "proxy",
      method,
      url
    });
    return response;
  }
}
