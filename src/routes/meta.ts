import type { FastifyInstance } from "fastify";

import { relayResponse } from "../core/stream.js";
import type { GatewayRuntime } from "../core/runtime.js";

interface RouteDeps {
  runtime: GatewayRuntime;
}

function getWorkspaceId(headerValue: unknown): string | undefined {
  return typeof headerValue === "string" ? headerValue : undefined;
}

export async function registerMetaRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/v1/models", async (request) => {
    const workspaceId = getWorkspaceId(request.headers["x-workspace-id"]);
    const data = await deps.runtime.getGateway().listModelsAggregated(
      request.headers, workspaceId
    );
    return { object: "list", data };
  });

  app.get("/v1/models/:modelId", async (request, reply) => {
    const { modelId } = request.params as { modelId: string };
    const workspaceId = getWorkspaceId(request.headers["x-workspace-id"]);
    const models = await deps.runtime.getGateway().listModelsAggregated(request.headers, workspaceId);
    const localMatch = models.find((item) => item.id === modelId);
    if (localMatch) {
      return localMatch;
    }

    const result = await deps.runtime.getGateway().dispatchGenericProxy(
      "GET", `/v1/models/${encodeURIComponent(modelId)}`,
      request.headers, undefined, workspaceId
    );
    return relayResponse(reply, result.response, {
      "x-gateway-upstream": result.upstream.id
    });
  });

  app.get("/admin/workspaces", async () => ({
    object: "list",
    data: deps.runtime.getGateway().getWorkspaceSummaries()
  }));

  app.get("/v1/gateway/usage", async (request) => {
    const workspaceId = getWorkspaceId(request.headers["x-workspace-id"]);
    return deps.runtime.getUsageSummary(workspaceId);
  });
}
