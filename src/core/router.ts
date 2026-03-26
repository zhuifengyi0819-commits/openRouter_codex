import type { IncomingHttpHeaders } from "node:http";
import { createHash } from "node:crypto";

import type {
  AnthropicMessagesRequest,
  OpenAIChatCompletionRequest,
  PersistedResponseRoute,
  PersistedSessionRoute,
  UpstreamConfig,
  UpstreamDispatch,
  UpstreamOperation,
  WorkspaceConfig,
  WorkspaceSummary
} from "../types/api.js";
import { OpenAIProvider } from "../providers/openai.provider.js";
import { AnthropicProvider } from "../providers/anthropic.provider.js";
import { UpstreamScheduler } from "./scheduler.js";
import { GatewayError } from "./http-error.js";
import { isCodexUpstream } from "./openai-upstream.js";

interface ModelDescriptor {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

interface ModelsCacheEntry {
  data: ModelDescriptor[];
  ts: number;
}

interface ResponseRouteEntry {
  upstreamId: string;
  workspaceId: string;
  expiresAt: number;
}

interface SessionRouteEntry {
  upstreamId: string;
  workspaceId: string;
  sessionId?: string;
  promptCacheKey?: string;
  expiresAt: number;
}

interface RequestAffinity {
  affinityKey: string;
  sessionId: string;
  promptCacheKey: string;
}

export class GatewayRouter {
  private readonly openAIProvider = new OpenAIProvider();
  private readonly anthropicProvider = new AnthropicProvider();
  private readonly upstreamsById: Map<string, UpstreamConfig>;
  private readonly workspacesById: Map<string, WorkspaceConfig>;

  private readonly modelsCache = new Map<string, ModelsCacheEntry>();
  private readonly responseRoutes = new Map<string, ResponseRouteEntry>();
  private readonly sessionRoutes = new Map<string, SessionRouteEntry>();
  private static readonly MODELS_CACHE_TTL_MS = 60_000;
  private static readonly RESPONSE_ROUTE_TTL_MS = 24 * 60 * 60_000;
  private static readonly SESSION_ROUTE_TTL_MS = 6 * 60 * 60_000;

  constructor(
    private readonly scheduler: UpstreamScheduler,
    private readonly modelMap: Record<string, string>,
    upstreams: UpstreamConfig[],
    workspaces: WorkspaceConfig[],
    private readonly defaultWorkspaceId?: string,
    persistedResponseRoutes: PersistedResponseRoute[] = [],
    persistedSessionRoutes: PersistedSessionRoute[] = [],
    private readonly onRoutingStateChanged?: (state: {
      responseRoutes: PersistedResponseRoute[];
      sessionRoutes: PersistedSessionRoute[];
    }) => void
  ) {
    this.upstreamsById = new Map(upstreams.map((upstream) => [upstream.id, upstream]));
    this.workspacesById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    for (const route of persistedResponseRoutes) {
      if (route.expiresAt > Date.now()) {
        this.responseRoutes.set(route.responseId, {
          upstreamId: route.upstreamId,
          workspaceId: route.workspaceId,
          expiresAt: route.expiresAt
        });
      }
    }
    for (const route of persistedSessionRoutes) {
      if (route.expiresAt > Date.now()) {
        this.sessionRoutes.set(route.affinityKey, {
          upstreamId: route.upstreamId,
          workspaceId: route.workspaceId,
          sessionId: route.sessionId,
          promptCacheKey: route.promptCacheKey,
          expiresAt: route.expiresAt
        });
      }
    }
  }

  public getSchedulerSnapshot() {
    return this.scheduler.snapshot();
  }

  public getRuntimeSummary(): {
    scheduler: ReturnType<UpstreamScheduler["snapshot"]>;
    modelsCache: Array<{ workspaceId: string; ageMs: number; modelCount: number }>;
    responseRoutes: { total: number; active: number; expired: number };
    sessionRoutes: { total: number; active: number; expired: number };
  } {
    const now = Date.now();
    let activeResponseRoutes = 0;
    let expiredResponseRoutes = 0;
    let activeSessionRoutes = 0;
    let expiredSessionRoutes = 0;
    for (const entry of this.responseRoutes.values()) {
      if (entry.expiresAt > now) {
        activeResponseRoutes += 1;
      } else {
        expiredResponseRoutes += 1;
      }
    }
    for (const entry of this.sessionRoutes.values()) {
      if (entry.expiresAt > now) {
        activeSessionRoutes += 1;
      } else {
        expiredSessionRoutes += 1;
      }
    }

    return {
      scheduler: this.scheduler.snapshot(),
      modelsCache: Array.from(this.modelsCache.entries()).map(([workspaceId, entry]) => ({
        workspaceId,
        ageMs: Math.max(0, now - entry.ts),
        modelCount: entry.data.length
      })),
      responseRoutes: {
        total: this.responseRoutes.size,
        active: activeResponseRoutes,
        expired: expiredResponseRoutes
      },
      sessionRoutes: {
        total: this.sessionRoutes.size,
        active: activeSessionRoutes,
        expired: expiredSessionRoutes
      }
    };
  }

  public getWorkspaceSummaries(): WorkspaceSummary[] {
    return Array.from(this.workspacesById.values()).map((workspace) => ({
      id: workspace.id,
      enabled: workspace.enabled !== false,
      isDefault: workspace.id === this.defaultWorkspaceId,
      upstreamIds: workspace.upstreamIds ?? [],
      availableModels: this.listModelsLocal(workspace).map((model) => model.id),
      upstreams: this.scheduler.snapshotByIds(workspace.upstreamIds ?? [])
    }));
  }

  public listModelsLocal(workspace?: WorkspaceConfig): ModelDescriptor[] {
    const ws = workspace ?? this.resolveWorkspaceOrNull();
    if (!ws) return [];
    return this.listModelsForWorkspace(ws);
  }

  public async listModelsAggregated(
    requestHeaders: IncomingHttpHeaders,
    workspaceId?: string
  ): Promise<ModelDescriptor[]> {
    const workspace = this.resolveWorkspace(workspaceId);
    const cacheEntry = this.modelsCache.get(workspace.id);
    if (cacheEntry && Date.now() - cacheEntry.ts < GatewayRouter.MODELS_CACHE_TTL_MS && cacheEntry.data.length > 0) {
      return cacheEntry.data;
    }

    const localModels = this.listModelsForWorkspace(workspace);
    const seen = new Set(localModels.map((m) => m.id));
    const result = [...localModels];

    const openaiUpstreams = Array.from(this.upstreamsById.values()).filter(
      (u) => u.kind === "openai" && !isCodexUpstream(u) && u.enabled !== false &&
        (workspace.upstreamIds?.includes(u.id) ?? true)
    );

    const fetches = openaiUpstreams.map(async (upstream) => {
      try {
        const res = await this.openAIProvider.listModels(upstream, requestHeaders);
        if (!res.ok) return [];
        const payload = (await res.json()) as { data?: Array<{ id?: string; created?: number; owned_by?: string }> };
        return (payload.data ?? [])
          .filter((m): m is { id: string; created?: number; owned_by?: string } =>
            typeof m.id === "string" && m.id.length > 0
          )
          .map((m) => ({
            id: m.id,
            object: "model" as const,
            owned_by: m.owned_by ?? upstream.id,
            created: m.created
          }));
      } catch {
        return [];
      }
    });

    const allResults = await Promise.allSettled(fetches);
    for (const r of allResults) {
      if (r.status === "fulfilled") {
        for (const m of r.value) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            result.push(m);
          }
        }
      }
    }

    result.sort((a, b) => a.id.localeCompare(b.id));
    this.modelsCache.set(workspace.id, {
      data: result,
      ts: Date.now()
    });
    return result;
  }

  private listModelsForWorkspace(workspace: WorkspaceConfig): ModelDescriptor[] {
    const models = new Set<string>();

    for (const key of Object.keys(this.modelMap)) {
      models.add(key);
    }

    for (const key of Object.keys(workspace.modelMap ?? {})) {
      models.add(key);
    }

    for (const upstreamId of workspace.upstreamIds ?? []) {
      const upstream = this.upstreamsById.get(upstreamId);
      if (!upstream?.models?.length) {
        continue;
      }

      for (const model of upstream.models) {
        models.add(model);
      }
    }

    return Array.from(models)
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({
        id,
        object: "model",
        owned_by: workspace.id
      }));
  }

  public async dispatchOpenAI(
    payload: OpenAIChatCompletionRequest,
    requestHeaders: IncomingHttpHeaders,
    workspaceId?: string
  ): Promise<UpstreamDispatch> {
    const workspace = this.resolveWorkspace(workspaceId);
    const resolvedModel = this.resolveModel(payload.model, workspace);
    const affinity = this.resolveOpenAIAffinity(payload, requestHeaders, workspace.id, resolvedModel);
    const upstreamPayload: OpenAIChatCompletionRequest = {
      ...payload,
      model: resolvedModel
    };
    const candidates = this.preferAffinityRoute(
      workspace,
      this.selectOpenAIUpstreams(workspace, resolvedModel, "chat"),
      affinity?.affinityKey
    );

    const result = await this.dispatchWithFailover(
      workspace.id,
      candidates,
      resolvedModel,
      "chat_completions",
      (upstream) => this.openAIProvider.createChatCompletion(upstream, upstreamPayload, requestHeaders, affinity),
    );
    this.storeSessionRouteFromDispatch(affinity, result);
    return result;
  }

  public async dispatchOpenAIResponses(
    payload: Record<string, unknown>,
    requestHeaders: IncomingHttpHeaders,
    workspaceId?: string
  ): Promise<UpstreamDispatch> {
    const workspace = this.resolveWorkspace(workspaceId);
    const model = typeof payload.model === "string" ? payload.model : "";
    const resolvedModel = this.resolveModel(model, workspace);
    const affinity = this.resolveOpenAIAffinity(payload, requestHeaders, workspace.id, resolvedModel);
    const upstreamPayload = { ...payload, model: resolvedModel };
    const candidates = this.preferAffinityRoute(
      workspace,
      this.selectOpenAIUpstreams(workspace, resolvedModel, "responses"),
      affinity?.affinityKey
    );

    const result = await this.dispatchWithFailover(
      workspace.id,
      candidates,
      resolvedModel,
      "responses",
      (upstream) => this.openAIProvider.createResponse(upstream, upstreamPayload, requestHeaders, affinity),
    );
    this.storeSessionRouteFromDispatch(affinity, result);
    await this.rememberResponseRouteFromResponse(result);
    return result;
  }

  public async dispatchOpenAIResponseItem(
    method: "GET" | "DELETE",
    responseId: string,
    requestHeaders: IncomingHttpHeaders,
    workspaceId?: string,
    preferredUpstreamId?: string
  ): Promise<UpstreamDispatch> {
    const workspace = this.resolveWorkspace(workspaceId);
    const rememberedUpstreamId = preferredUpstreamId ?? this.getRememberedResponseUpstreamId(responseId, workspace.id);
    const preferredUpstream = this.resolvePreferredUpstream(workspace, "openai", rememberedUpstreamId);
    const candidates = preferredUpstream
      ? [preferredUpstream, ...this.selectOpenAIUpstreams(workspace, "*", "responses", [preferredUpstream.id])]
      : this.selectOpenAIUpstreams(workspace, "*", "responses");

    const result = await this.dispatchWithFailover(
      workspace.id,
      candidates,
      "*",
      "response_item",
      (upstream) => this.openAIProvider.proxy(
        upstream,
        method,
        `/v1/responses/${encodeURIComponent(responseId)}`,
        requestHeaders
      ),
      {
        retryableStatuses: new Set([404, 408, 409, 425, 429, 500, 502, 503, 504])
      }
    );

    if (method === "GET") {
      await this.rememberResponseRouteFromResponse(result);
    } else if (result.response.ok) {
      this.responseRoutes.delete(responseId);
      this.emitRoutingStateChanged();
    }

    return result;
  }

  public async dispatchOpenAIEmbeddings(
    payload: Record<string, unknown>,
    requestHeaders: IncomingHttpHeaders,
    workspaceId?: string
  ): Promise<UpstreamDispatch> {
    const workspace = this.resolveWorkspace(workspaceId);
    const model = typeof payload.model === "string" ? payload.model : "";
    const resolvedModel = this.resolveModel(model, workspace);
    const upstreamPayload = { ...payload, model: resolvedModel };

    return this.dispatchWithFailover(
      workspace.id,
      this.selectOpenAIUpstreams(workspace, resolvedModel, "embeddings"),
      resolvedModel,
      "embeddings",
      (upstream) => this.openAIProvider.createEmbedding(upstream, upstreamPayload, requestHeaders),
    );
  }

  public async dispatchAnthropic(
    payload: AnthropicMessagesRequest,
    requestHeaders: IncomingHttpHeaders,
    workspaceId?: string
  ): Promise<UpstreamDispatch> {
    const workspace = this.resolveWorkspace(workspaceId);
    const resolvedModel = this.resolveModel(payload.model, workspace);
    const upstream = this.scheduler.choose({
      kind: "anthropic",
      model: resolvedModel,
      allowedUpstreamIds: workspace.upstreamIds
    });

    const upstreamPayload: AnthropicMessagesRequest = {
      ...payload,
      model: resolvedModel
    };

    return this.dispatch(workspace.id, upstream, resolvedModel, "anthropic_messages", () =>
      this.anthropicProvider.createMessage(upstream, upstreamPayload, requestHeaders)
    );
  }

  public async dispatchGenericProxy(
    method: string,
    path: string,
    requestHeaders: IncomingHttpHeaders,
    body?: string,
    workspaceId?: string
  ): Promise<UpstreamDispatch> {
    const workspace = this.resolveWorkspace(workspaceId);
    return this.dispatchWithFailover(
      workspace.id,
      this.selectOpenAIUpstreams(workspace, "*", "proxy"),
      "*",
      "proxy",
      (upstream) => this.openAIProvider.proxy(upstream, method, path, requestHeaders, body),
    );
  }

  public resolveWorkspace(requestedWorkspaceId?: string): WorkspaceConfig {
    const targetId = requestedWorkspaceId ?? this.defaultWorkspaceId;
    if (!targetId) {
      throw new GatewayError(503, "No workspace configured");
    }

    const workspace = this.workspacesById.get(targetId);
    if (!workspace) {
      throw new GatewayError(404, `Unknown workspace "${targetId}"`);
    }

    if (workspace.enabled === false) {
      throw new GatewayError(403, `Workspace "${targetId}" is disabled`);
    }

    return workspace;
  }

  private resolveWorkspaceOrNull(): WorkspaceConfig | undefined {
    const targetId = this.defaultWorkspaceId;
    if (!targetId) return undefined;
    return this.workspacesById.get(targetId);
  }

  private resolveModel(model: string, workspace: WorkspaceConfig): string {
    if (model === "*") return model;
    return workspace.modelMap?.[model] ?? this.modelMap[model] ?? model;
  }

  private resolvePreferredUpstream(
    workspace: WorkspaceConfig,
    kind: UpstreamConfig["kind"],
    upstreamId?: string
  ): UpstreamConfig | undefined {
    if (!upstreamId) {
      return undefined;
    }

    const upstream = this.upstreamsById.get(upstreamId);
    if (!upstream || upstream.kind !== kind || upstream.enabled === false) {
      return undefined;
    }

    if (workspace.upstreamIds?.length && !workspace.upstreamIds.includes(upstream.id)) {
      return undefined;
    }

    return upstream;
  }

  private supportsOpenAIOperation(
    upstream: UpstreamConfig,
    operation: "chat" | "responses" | "embeddings" | "proxy"
  ): boolean {
    if (upstream.kind !== "openai") {
      return false;
    }

    if (operation === "embeddings") {
      return !isCodexUpstream(upstream);
    }

    if (operation === "proxy") {
      return !isCodexUpstream(upstream);
    }

    return true;
  }

  private preferAffinityRoute(
    workspace: WorkspaceConfig,
    candidates: UpstreamConfig[],
    affinityKey?: string
  ): UpstreamConfig[] {
    if (!affinityKey) {
      return candidates;
    }

    const preferredUpstreamId = this.getRememberedSessionUpstreamId(affinityKey, workspace.id);
    if (!preferredUpstreamId) {
      return candidates;
    }

    const preferred = candidates.find((upstream) => upstream.id === preferredUpstreamId);
    if (!preferred) {
      return candidates;
    }

    return [preferred, ...candidates.filter((upstream) => upstream.id !== preferredUpstreamId)];
  }

  private selectOpenAIUpstreams(
    workspace: WorkspaceConfig,
    model: string,
    operation: "chat" | "responses" | "embeddings" | "proxy",
    excludedUpstreamIds: string[] = []
  ): UpstreamConfig[] {
    const allowedUpstreamIds = Array.from(this.upstreamsById.values())
      .filter((upstream) =>
        this.supportsOpenAIOperation(upstream, operation) &&
        (workspace.upstreamIds?.includes(upstream.id) ?? true)
      )
      .map((upstream) => upstream.id);

    if (allowedUpstreamIds.length === 0) {
      throw new GatewayError(503, `No upstream available for openai operation "${operation}"`);
    }

    return this.scheduler.orderCandidates({
      kind: "openai",
      model,
      allowedUpstreamIds
    }, excludedUpstreamIds);
  }

  private async dispatchWithFailover(
    workspaceId: string,
    candidates: UpstreamConfig[],
    resolvedModel: string,
    operation: UpstreamOperation,
    send: (upstream: UpstreamConfig) => Promise<Response>,
    options?: {
      retryableStatuses?: Set<number>;
      retryOnNetworkError?: boolean;
    }
  ): Promise<UpstreamDispatch> {
    const retryableStatuses = options?.retryableStatuses ?? new Set([408, 425, 429, 500, 502, 503, 504]);
    const retryOnNetworkError = options?.retryOnNetworkError ?? true;

    let lastError: GatewayError | undefined;
    for (let index = 0; index < candidates.length; index += 1) {
      const upstream = candidates[index]!;
      const hasNext = index < candidates.length - 1;
      try {
        const result = await this.dispatch(workspaceId, upstream, resolvedModel, operation, () => send(upstream));
        if (result.response.ok || !hasNext || !retryableStatuses.has(result.response.status)) {
          return result;
        }

        console.log(
          `[dispatch] RETRY workspace=${workspaceId} upstream=${upstream.id} status=${result.response.status} next=${candidates[index + 1]!.id}`
        );
      } catch (error) {
        if (error instanceof GatewayError && retryOnNetworkError && error.statusCode === 502 && hasNext) {
          console.log(
            `[dispatch] RETRY workspace=${workspaceId} upstream=${upstream.id} network_error next=${candidates[index + 1]!.id}`
          );
          lastError = error;
          continue;
        }

        throw error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new GatewayError(503, "No upstream available after failover");
  }

  private async dispatch(
    workspaceId: string,
    upstream: UpstreamConfig,
    resolvedModel: string,
    operation: UpstreamOperation,
    send: () => Promise<Response>
  ): Promise<UpstreamDispatch> {
    console.log(
      `[dispatch] upstream=${upstream.id} model=${resolvedModel} baseUrl=${upstream.baseUrl} auth=${upstream.authMode ?? "api_key"}`
    );

    const startedAt = Date.now();
    try {
      const response = await send();
      const latencyMs = Date.now() - startedAt;

      if (response.ok) {
        this.scheduler.markSuccess(upstream.id, response.status, {
          operation,
          latencyMs
        });
        void this.captureUsageFromResponse(upstream.id, operation, response.clone());
        console.log(`[dispatch] OK ${upstream.id} -> ${response.status}`);
      } else {
        const errorBody = await this.tryReadError(response.clone());
        this.scheduler.markFailure(upstream, response.status, errorBody, {
          operation,
          latencyMs
        });
        console.log(
          `[dispatch] FAIL ${upstream.id} -> ${response.status} body=${errorBody ?? "(empty)"}`
        );
      }

      return {
        upstream,
        workspaceId,
        resolvedModel,
        response
      };
    } catch (error) {
      this.scheduler.markNetworkError(upstream, error as Error, {
        operation,
        latencyMs: Date.now() - startedAt
      });
      console.log(`[dispatch] ERR ${upstream.id} network error: ${(error as Error).message}`);
      throw new GatewayError(502, `Upstream request failed for "${upstream.id}"`, {
        upstreamId: upstream.id,
        workspaceId,
        cause: (error as Error).message
      });
    }
  }

  private async tryReadError(response: Response): Promise<string | undefined> {
    try {
      const text = await response.text();
      return text.slice(0, 500);
    } catch {
      return undefined;
    }
  }

  private async captureUsageFromResponse(
    upstreamId: string,
    operation: UpstreamOperation,
    response: Response
  ): Promise<void> {
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const payload = await response.json() as Record<string, unknown>;
        const usage = this.extractUsage(payload);
        if (usage) {
          this.scheduler.recordUsage(upstreamId, {
            operation,
            ...usage
          });
        }
        return;
      }

      if (contentType.includes("text/event-stream") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let separator = buffer.indexOf("\n\n");
          while (separator !== -1) {
            const chunk = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const data = chunk
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("\n")
              .trim();

            if (!data || data === "[DONE]") {
              separator = buffer.indexOf("\n\n");
              continue;
            }

            const payload = JSON.parse(data) as Record<string, unknown>;
            const usage = this.extractUsage(payload);
            if (usage) {
              this.scheduler.recordUsage(upstreamId, {
                operation,
                ...usage
              });
              return;
            }

            separator = buffer.indexOf("\n\n");
          }
        }
      }
    } catch {
      /* best-effort */
    }
  }

  private extractUsage(payload: Record<string, unknown>): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | undefined {
    const usageCandidate = this.pickUsageObject(payload);
    if (!usageCandidate) {
      return undefined;
    }

    const promptTokens = this.readUsageNumber(usageCandidate, "prompt_tokens", "input_tokens");
    const completionTokens = this.readUsageNumber(usageCandidate, "completion_tokens", "output_tokens");
    const totalTokens = this.readUsageNumber(usageCandidate, "total_tokens")
      ?? (promptTokens !== undefined || completionTokens !== undefined
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined);

    if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
      return undefined;
    }

    return {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      totalTokens: totalTokens ?? 0
    };
  }

  private pickUsageObject(payload: Record<string, unknown>): Record<string, unknown> | undefined {
    const directUsage = this.asObject(payload.usage);
    if (directUsage) {
      return directUsage;
    }

    const responseUsage = this.asObject(this.asObject(payload.response)?.usage);
    if (responseUsage) {
      return responseUsage;
    }

    const messageUsage = this.asObject(this.asObject(payload.message)?.usage);
    if (messageUsage) {
      return messageUsage;
    }

    return undefined;
  }

  private readUsageNumber(usage: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return undefined;
  }

  private asObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private getRememberedResponseUpstreamId(responseId: string, workspaceId: string): string | undefined {
    const entry = this.responseRoutes.get(responseId);
    if (!entry) {
      return undefined;
    }

    if (entry.workspaceId !== workspaceId || entry.expiresAt <= Date.now()) {
      this.responseRoutes.delete(responseId);
      this.emitRoutingStateChanged();
      return undefined;
    }

    return entry.upstreamId;
  }

  private getRememberedSessionUpstreamId(affinityKey: string, workspaceId: string): string | undefined {
    const entry = this.sessionRoutes.get(affinityKey);
    if (!entry) {
      return undefined;
    }

    if (entry.workspaceId !== workspaceId || entry.expiresAt <= Date.now()) {
      this.sessionRoutes.delete(affinityKey);
      this.emitRoutingStateChanged();
      return undefined;
    }

    return entry.upstreamId;
  }

  private async rememberResponseRouteFromResponse(result: UpstreamDispatch): Promise<void> {
    const contentType = result.response.headers.get("content-type") ?? "";
    if (!result.response.ok) {
      return;
    }

    if (contentType.includes("application/json")) {
      try {
        const payload = (await result.response.clone().json()) as { id?: unknown };
        if (typeof payload.id === "string" && payload.id.length > 0) {
          this.storeResponseRoute(payload.id, result.upstream.id, result.workspaceId);
        }
      } catch {
        /* best-effort */
      }
      return;
    }

    if (contentType.includes("text/event-stream")) {
      void this.rememberResponseRouteFromStream(result);
    }
  }

  private async rememberResponseRouteFromStream(result: UpstreamDispatch): Promise<void> {
    try {
      const response = result.response.clone();
      if (!response.body) {
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const chunk = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const data = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n")
            .trim();

          if (!data || data === "[DONE]") {
            separator = buffer.indexOf("\n\n");
            continue;
          }

          const payload = JSON.parse(data) as { id?: unknown; response?: { id?: unknown } };
          const responseId =
            typeof payload.id === "string"
              ? payload.id
              : typeof payload.response?.id === "string"
                ? payload.response.id
                : undefined;

          if (responseId) {
            this.storeResponseRoute(responseId, result.upstream.id, result.workspaceId);
            return;
          }

          separator = buffer.indexOf("\n\n");
        }
      }
    } catch {
      /* best-effort */
    }
  }

  private storeResponseRoute(responseId: string, upstreamId: string, workspaceId: string): void {
    this.responseRoutes.set(responseId, {
      upstreamId,
      workspaceId,
      expiresAt: Date.now() + GatewayRouter.RESPONSE_ROUTE_TTL_MS
    });
    this.emitRoutingStateChanged();
  }

  private storeSessionRouteFromDispatch(affinity: RequestAffinity | undefined, result: UpstreamDispatch): void {
    if (!affinity || !result.response.ok) {
      return;
    }

    this.sessionRoutes.set(affinity.affinityKey, {
      upstreamId: result.upstream.id,
      workspaceId: result.workspaceId,
      sessionId: affinity.sessionId,
      promptCacheKey: affinity.promptCacheKey,
      expiresAt: Date.now() + GatewayRouter.SESSION_ROUTE_TTL_MS
    });
    this.emitRoutingStateChanged();
  }

  private emitRoutingStateChanged(): void {
    if (!this.onRoutingStateChanged) {
      return;
    }

    const now = Date.now();
    const responseRoutes: PersistedResponseRoute[] = [];
    for (const [responseId, entry] of this.responseRoutes.entries()) {
      if (entry.expiresAt <= now) {
        this.responseRoutes.delete(responseId);
        continue;
      }

      responseRoutes.push({
        responseId,
        upstreamId: entry.upstreamId,
        workspaceId: entry.workspaceId,
        expiresAt: entry.expiresAt
      });
    }
    const sessionRoutes: PersistedSessionRoute[] = [];
    for (const [affinityKey, entry] of this.sessionRoutes.entries()) {
      if (entry.expiresAt <= now) {
        this.sessionRoutes.delete(affinityKey);
        continue;
      }

      sessionRoutes.push({
        affinityKey,
        upstreamId: entry.upstreamId,
        workspaceId: entry.workspaceId,
        sessionId: entry.sessionId,
        promptCacheKey: entry.promptCacheKey,
        expiresAt: entry.expiresAt
      });
    }

    this.onRoutingStateChanged({
      responseRoutes,
      sessionRoutes
    });
  }

  private resolveOpenAIAffinity(
    payload: Record<string, unknown>,
    requestHeaders: IncomingHttpHeaders,
    workspaceId: string,
    resolvedModel: string
  ): RequestAffinity | undefined {
    const explicitSessionId = this.readFirstString(
      this.readHeaderValue(requestHeaders, "session_id"),
      this.readHeaderValue(requestHeaders, "x-stainless-session-id"),
      this.readHeaderValue(requestHeaders, "x-session-id"),
      this.readHeaderValue(requestHeaders, "x-gateway-session"),
      this.readNestedString(payload, "session_id"),
      this.readNestedString(payload, "metadata", "session_id")
    );
    const explicitPromptCacheKey = this.readFirstString(
      this.readHeaderValue(requestHeaders, "prompt_cache_key"),
      this.readHeaderValue(requestHeaders, "x-prompt-cache-key"),
      this.readNestedString(payload, "prompt_cache_key"),
      this.readNestedString(payload, "metadata", "prompt_cache_key")
    );

    const derivedKey = explicitSessionId ?? explicitPromptCacheKey ?? this.createPromptCacheKey(workspaceId, resolvedModel, payload);
    if (!derivedKey) {
      return undefined;
    }

    return {
      affinityKey: explicitSessionId
        ? `session:${explicitSessionId}`
        : explicitPromptCacheKey
          ? `prompt:${explicitPromptCacheKey}`
          : `fingerprint:${derivedKey}`,
      sessionId: explicitSessionId ?? derivedKey,
      promptCacheKey: explicitPromptCacheKey ?? explicitSessionId ?? derivedKey
    };
  }

  private createPromptCacheKey(
    workspaceId: string,
    resolvedModel: string,
    payload: Record<string, unknown>
  ): string {
    const serialized = this.stableSerialize({
      workspaceId,
      model: resolvedModel,
      request: this.pickPromptFingerprintPayload(payload)
    });
    return `gw_${createHash("sha256").update(serialized).digest("hex").slice(0, 32)}`;
  }

  private pickPromptFingerprintPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const key of [
      "messages",
      "input",
      "instructions",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "modalities",
      "audio",
      "reasoning",
      "response_format",
      "text",
      "temperature",
      "top_p",
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens"
    ]) {
      if (key in payload) {
        picked[key] = payload[key];
      }
    }
    return picked;
  }

  private stableSerialize(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableSerialize(item)).join(",")}]`;
    }
    if (!value || typeof value !== "object") {
      return JSON.stringify(value);
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${this.stableSerialize(entry)}`);
    return `{${entries.join(",")}}`;
  }

  private readHeaderValue(headers: IncomingHttpHeaders, key: string): string | undefined {
    const value = headers[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      return value.find((item) => typeof item === "string" && item.trim().length > 0)?.trim();
    }
    return undefined;
  }

  private readNestedString(value: unknown, ...path: string[]): string | undefined {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return typeof current === "string" && current.trim().length > 0 ? current.trim() : undefined;
  }

  private readFirstString(...values: Array<string | undefined>): string | undefined {
    return values.find((value) => typeof value === "string" && value.length > 0);
  }
}
