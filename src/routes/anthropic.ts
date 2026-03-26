import type { FastifyInstance } from "fastify";

import { normalizeAnthropicRequest } from "../adapters/anthropic.adapter.js";
import { relayResponse } from "../core/stream.js";
import type { GatewayRuntime } from "../core/runtime.js";

interface RouteDeps {
  runtime: GatewayRuntime;
}

export async function registerAnthropicRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.post("/v1/messages", async (request, reply) => {
    const workspaceId =
      typeof request.headers["x-workspace-id"] === "string"
        ? request.headers["x-workspace-id"]
        : undefined;
    const { payload } = normalizeAnthropicRequest(request.body);
    const result = await deps.runtime.getGateway().dispatchAnthropic(payload, request.headers, workspaceId);

    return relayResponse(reply, result.response, {
      "x-gateway-upstream": result.upstream.id,
      "x-gateway-model": result.resolvedModel,
      "x-gateway-workspace": result.workspaceId,
      "x-anthropic-version": String(request.headers["anthropic-version"] ?? "2023-06-01")
    });
  });
}
