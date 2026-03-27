import type { FastifyInstance } from "fastify";

import {
  normalizeOpenAIEmbeddingsRequest,
  normalizeOpenAIRequest,
  normalizeOpenAIResponsesRequest
} from "../adapters/openai.adapter.js";
import { relayResponse } from "../core/stream.js";
import type { GatewayRuntime } from "../core/runtime.js";

interface RouteDeps {
  runtime: GatewayRuntime;
}

function getWorkspaceId(request: { headers: Record<string, unknown> }): string | undefined {
  const v = request.headers["x-workspace-id"];
  return typeof v === "string" ? v : undefined;
}

function getPreferredUpstreamId(request: { headers: Record<string, unknown> }): string | undefined {
  const v = request.headers["x-gateway-upstream"];
  return typeof v === "string" ? v : undefined;
}

const GATEWAY_HEADERS = (result: { upstream: { id: string }; resolvedModel: string; workspaceId: string }) => ({
  "x-gateway-upstream": result.upstream.id,
  "x-gateway-model": result.resolvedModel,
  "x-gateway-workspace": result.workspaceId
});

export async function registerOpenAIRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {

  app.post("/v1/chat/completions", async (request, reply) => {
    const { payload } = normalizeOpenAIRequest(request.body);
    const result = await deps.runtime.getGateway().dispatchOpenAI(
      payload, request.headers, getWorkspaceId(request as any)
    );
    return relayResponse(reply, result.response, GATEWAY_HEADERS(result));
  });

  app.post("/v1/responses", async (request, reply) => {
    const { payload } = normalizeOpenAIResponsesRequest(request.body);
    const result = await deps.runtime.getGateway().dispatchOpenAIResponses(
      payload, request.headers, getWorkspaceId(request as any)
    );
    return relayResponse(reply, result.response, GATEWAY_HEADERS(result));
  });

  app.post("/v1/embeddings", async (request, reply) => {
    const { payload } = normalizeOpenAIEmbeddingsRequest(request.body);
    const result = await deps.runtime.getGateway().dispatchOpenAIEmbeddings(
      payload, request.headers, getWorkspaceId(request as any)
    );
    return relayResponse(reply, result.response, GATEWAY_HEADERS(result));
  });

  app.get("/v1/responses/:responseId", async (request, reply) => {
    const { responseId } = request.params as { responseId: string };
    const result = await deps.runtime.getGateway().dispatchOpenAIResponseItem(
      "GET",
      responseId,
      request.headers,
      getWorkspaceId(request as any),
      getPreferredUpstreamId(request as any)
    );
    return relayResponse(reply, result.response, GATEWAY_HEADERS(result));
  });

  app.delete("/v1/responses/:responseId", async (request, reply) => {
    const { responseId } = request.params as { responseId: string };
    const result = await deps.runtime.getGateway().dispatchOpenAIResponseItem(
      "DELETE",
      responseId,
      request.headers,
      getWorkspaceId(request as any),
      getPreferredUpstreamId(request as any)
    );
    return relayResponse(reply, result.response, GATEWAY_HEADERS(result));
  });
}
