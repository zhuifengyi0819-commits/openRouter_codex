import type { AnthropicMessagesRequest } from "../types/api.js";
import { GatewayError } from "../core/http-error.js";

export function normalizeAnthropicRequest(body: unknown): {
  payload: AnthropicMessagesRequest;
  publicModel: string;
} {
  if (!body || typeof body !== "object") {
    throw new GatewayError(400, "Request body must be a JSON object");
  }

  const payload = body as AnthropicMessagesRequest;
  if (typeof payload.model !== "string" || payload.model.trim().length === 0) {
    throw new GatewayError(400, "`model` is required");
  }

  if (typeof payload.max_tokens !== "number") {
    throw new GatewayError(400, "`max_tokens` is required for Anthropic-compatible requests");
  }

  return {
    payload,
    publicModel: payload.model
  };
}
