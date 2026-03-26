import type { OpenAIChatCompletionRequest } from "../types/api.js";
import { GatewayError } from "../core/http-error.js";

export function normalizeOpenAIRequest(body: unknown): {
  payload: OpenAIChatCompletionRequest;
  publicModel: string;
} {
  if (!body || typeof body !== "object") {
    throw new GatewayError(400, "Request body must be a JSON object");
  }

  const payload = body as OpenAIChatCompletionRequest;
  if (typeof payload.model !== "string" || payload.model.trim().length === 0) {
    throw new GatewayError(400, "`model` is required");
  }

  return {
    payload,
    publicModel: payload.model
  };
}
