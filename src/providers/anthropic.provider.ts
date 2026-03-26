import type { IncomingHttpHeaders } from "node:http";

import type { AnthropicMessagesRequest, UpstreamConfig } from "../types/api.js";
import { buildAuthHeaders } from "../core/upstream-auth.js";

function appendIfPresent(headers: Headers, source: IncomingHttpHeaders, key: string): void {
  const value = source[key];
  if (typeof value === "string" && value.length > 0) {
    headers.set(key, value);
  }
}

export class AnthropicProvider {
  public async createMessage(
    upstream: UpstreamConfig,
    payload: AnthropicMessagesRequest,
    requestHeaders: IncomingHttpHeaders
  ): Promise<Response> {
    const headers = new Headers({
      "content-type": "application/json",
      ...buildAuthHeaders(upstream),
      "anthropic-version": "2023-06-01",
      ...upstream.headers
    });

    appendIfPresent(headers, requestHeaders, "anthropic-version");
    appendIfPresent(headers, requestHeaders, "anthropic-beta");

    return fetch(`${upstream.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });
  }
}
