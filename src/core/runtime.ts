import { normalizeWorkspaces } from "../config/env.js";
import type {
  GatewayConfig,
  PendingOAuthConnection,
  PersistedGatewayState,
  PersistedResponseRoute,
  PersistedSessionRoute,
  UpstreamConfig,
  WorkspaceConfig
} from "../types/api.js";
import { GatewayRouter } from "./router.js";
import { UpstreamScheduler } from "./scheduler.js";
import { SecretStore } from "./secret-store.js";
import { GatewayError } from "./http-error.js";
import {
  buildCodexHeaders,
  extractChatGPTAccountId,
  getOpenAIUpstreamMode,
  isCodexUpstream,
  resolveCodexResponsesUrl
} from "./openai-upstream.js";
import { buildAuthHeaders } from "./upstream-auth.js";

export class GatewayRuntime {
  private currentPersistedState: PersistedGatewayState = {
    upstreams: [],
    workspaces: [],
    responseRoutes: [],
    sessionRoutes: []
  };

  private mergedConfig: GatewayConfig;
  private gateway: GatewayRouter;
  private readonly startedAt = Date.now();
  private stateSaveQueue: Promise<void> = Promise.resolve();
  private pendingStateFlushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly baseConfig: GatewayConfig,
    private readonly store: SecretStore
  ) {
    this.mergedConfig = baseConfig;
    this.gateway = this.createGateway(baseConfig);
  }

  public async initialize(): Promise<void> {
    const loadedState = await this.store.load();
    this.currentPersistedState = this.prunePersistedState(loadedState);
    this.applyState(this.currentPersistedState);
    if (
      (loadedState.responseRoutes?.length ?? 0) !== (this.currentPersistedState.responseRoutes?.length ?? 0) ||
      (loadedState.sessionRoutes?.length ?? 0) !== (this.currentPersistedState.sessionRoutes?.length ?? 0)
    ) {
      await this.queuePersistState(this.currentPersistedState);
    }
  }

  public getGateway(): GatewayRouter {
    return this.gateway;
  }

  public getConfig(): GatewayConfig {
    return this.mergedConfig;
  }

  public getPersistedState(): PersistedGatewayState {
    return this.currentPersistedState;
  }

  public getStoragePaths(): { dataDir: string; keyPath: string; statePath: string } {
    return this.store.getPaths();
  }

  public getRuntimeSummary(): {
    startedAt: string;
    uptimeMs: number;
    configuredUpstreams: number;
    configuredWorkspaces: number;
    persistedResponseRoutes: number;
    persistedSessionRoutes: number;
    scheduler: ReturnType<GatewayRouter["getRuntimeSummary"]>["scheduler"];
    modelsCache: ReturnType<GatewayRouter["getRuntimeSummary"]>["modelsCache"];
    responseRoutes: ReturnType<GatewayRouter["getRuntimeSummary"]>["responseRoutes"];
    sessionRoutes: ReturnType<GatewayRouter["getRuntimeSummary"]>["sessionRoutes"];
  } {
    const gatewaySummary = this.gateway.getRuntimeSummary();
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      configuredUpstreams: this.mergedConfig.upstreams.length,
      configuredWorkspaces: this.mergedConfig.workspaces.length,
      persistedResponseRoutes: this.currentPersistedState.responseRoutes?.length ?? 0,
      persistedSessionRoutes: this.currentPersistedState.sessionRoutes?.length ?? 0,
      scheduler: gatewaySummary.scheduler,
      modelsCache: gatewaySummary.modelsCache,
      responseRoutes: gatewaySummary.responseRoutes,
      sessionRoutes: gatewaySummary.sessionRoutes
    };
  }

  public async previewUpstream(input: UpstreamConfig): Promise<UpstreamConfig> {
    return this.normalizeAdminUpstream(input);
  }

  public async upsertUpstream(input: UpstreamConfig): Promise<void> {
    const upstream = this.normalizeAdminUpstream(input);
    if (this.baseConfig.upstreams.some((item) => item.id === upstream.id)) {
      throw new GatewayError(409, `Upstream "${upstream.id}" is managed by environment config and cannot be overwritten from admin UI`);
    }

    const nextUpstreams = this.currentPersistedState.upstreams.filter((item) => item.id !== upstream.id);
    nextUpstreams.push(upstream);

    await this.saveAndReload({
      ...this.currentPersistedState,
      upstreams: nextUpstreams
    });
  }

  public async upsertOAuthUpstreamByAccountId(input: UpstreamConfig): Promise<{
    upstreamId: string;
    replacedIds: string[];
  }> {
    const upstream = this.normalizeAdminUpstream(input);
    if (this.baseConfig.upstreams.some((item) => item.id === upstream.id)) {
      throw new GatewayError(409, `Upstream "${upstream.id}" is managed by environment config and cannot be overwritten from admin UI`);
    }

    const accountId = upstream.oauth2?.accountId?.trim();
    if (upstream.authMode !== "oauth2" || !accountId) {
      await this.upsertUpstream(upstream);
      return {
        upstreamId: upstream.id,
        replacedIds: []
      };
    }

    const duplicates = this.currentPersistedState.upstreams.filter((item) =>
      item.authMode === "oauth2" && item.oauth2?.accountId === accountId
    );
    const canonicalId = duplicates[0]?.id ?? upstream.id;
    const aliasIds = new Set<string>([upstream.id, ...duplicates.map((item) => item.id)]);
    const replacedIds = [...aliasIds].filter((id) => id !== canonicalId);

    const dedupeIds = (ids: string[] | undefined): string[] | undefined => {
      if (!ids) {
        return ids;
      }

      const next: string[] = [];
      for (const id of ids) {
        const resolved = aliasIds.has(id) ? canonicalId : id;
        if (!next.includes(resolved)) {
          next.push(resolved);
        }
      }
      return next;
    };

    const nextUpstreams = this.currentPersistedState.upstreams.filter((item) => !aliasIds.has(item.id));
    nextUpstreams.push({
      ...upstream,
      id: canonicalId,
      oauth2: upstream.oauth2
        ? {
            ...upstream.oauth2,
            accountId
          }
        : upstream.oauth2
    });

    await this.saveAndReload({
      ...this.currentPersistedState,
      upstreams: nextUpstreams,
      workspaces: this.currentPersistedState.workspaces.map((workspace) => ({
        ...workspace,
        upstreamIds: dedupeIds(workspace.upstreamIds)
      })),
      responseRoutes: this.currentPersistedState.responseRoutes?.map((route) => ({
        ...route,
        upstreamId: aliasIds.has(route.upstreamId) ? canonicalId : route.upstreamId
      })),
      sessionRoutes: this.currentPersistedState.sessionRoutes?.map((route) => ({
        ...route,
        upstreamId: aliasIds.has(route.upstreamId) ? canonicalId : route.upstreamId
      }))
    });

    return {
      upstreamId: canonicalId,
      replacedIds
    };
  }

  public async upsertWorkspace(input: WorkspaceConfig): Promise<void> {
    const workspace = this.normalizeAdminWorkspace(input);
    if (this.baseConfig.workspaces.some((item) => item.id === workspace.id)) {
      throw new GatewayError(409, `Workspace "${workspace.id}" is managed by environment config and cannot be overwritten from admin UI`);
    }

    const nextWorkspaces = this.currentPersistedState.workspaces.filter((item) => item.id !== workspace.id);
    nextWorkspaces.push(workspace);

    await this.saveAndReload({
      ...this.currentPersistedState,
      workspaces: nextWorkspaces
    });
  }

  public async updateUpstream(
    upstreamId: string,
    patch: Partial<UpstreamConfig> & {
      apiKey?: string;
      oauth2?: Partial<NonNullable<UpstreamConfig["oauth2"]>>;
    }
  ): Promise<void> {
    if (this.baseConfig.upstreams.some((item) => item.id === upstreamId)) {
      throw new GatewayError(409, `Upstream "${upstreamId}" is managed by environment config and cannot be modified from admin UI`);
    }

    const current = this.currentPersistedState.upstreams.find((item) => item.id === upstreamId);
    if (!current) {
      throw new GatewayError(404, `Unknown upstream "${upstreamId}"`);
    }

    const merged: UpstreamConfig = {
      ...current,
      ...patch,
      id: current.id,
      kind: current.kind,
      openaiMode: current.openaiMode,
      authMode: current.authMode,
      apiKey:
        typeof patch.apiKey === "string" && patch.apiKey.trim().length > 0
          ? patch.apiKey.trim()
          : current.apiKey,
      oauth2: current.oauth2
        ? {
            ...current.oauth2,
            ...(patch.oauth2 ?? {}),
            accessToken: current.oauth2.accessToken,
            refreshToken: patch.oauth2?.refreshToken ?? current.oauth2.refreshToken,
            clientSecret: patch.oauth2?.clientSecret?.trim()
              ? patch.oauth2.clientSecret.trim()
              : current.oauth2.clientSecret,
            clientId: patch.oauth2?.clientId?.trim()
              ? patch.oauth2.clientId.trim()
              : current.oauth2.clientId
          }
        : undefined
    };

    await this.upsertUpstream(merged);
  }

  public async updateWorkspace(
    workspaceId: string,
    patch: Partial<WorkspaceConfig>
  ): Promise<void> {
    if (this.baseConfig.workspaces.some((item) => item.id === workspaceId)) {
      throw new GatewayError(409, `Workspace "${workspaceId}" is managed by environment config and cannot be modified from admin UI`);
    }

    const current = this.currentPersistedState.workspaces.find((item) => item.id === workspaceId);
    if (!current) {
      throw new GatewayError(404, `Unknown workspace "${workspaceId}"`);
    }

    await this.upsertWorkspace({
      ...current,
      ...patch,
      id: current.id
    });
  }

  public async refreshUpstreamModels(upstreamId: string): Promise<string[]> {
    const upstream = this.mergedConfig.upstreams.find((item) => item.id === upstreamId);
    if (!upstream) {
      throw new GatewayError(404, `Unknown upstream "${upstreamId}"`);
    }

    if (upstream.kind !== "openai") {
      throw new GatewayError(400, "Automatic model refresh is currently implemented only for OpenAI-compatible upstreams");
    }

    if (isCodexUpstream(upstream)) {
      throw new GatewayError(400, "Codex subscription upstreams do not expose /v1/models. Maintain the model list manually.");
    }

    const response = await fetch(`${upstream.baseUrl}/v1/models`, {
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(upstream, "authorization_bearer"),
        ...upstream.headers
      },
      signal: AbortSignal.timeout(upstream.timeoutMs ?? this.baseConfig.requestTimeoutMs)
    });

    if (!response.ok) {
      throw new GatewayError(502, `Model refresh failed with status ${response.status}`, {
        upstreamId,
        body: await response.text()
      });
    }

    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (payload.data ?? [])
      .map((item) => item.id)
      .filter((item): item is string => typeof item === "string" && item.length > 0)
      .sort((left, right) => left.localeCompare(right));

    await this.upsertUpstream({
      ...upstream,
      models
    });

    return models;
  }

  public async setUpstreamEnabled(upstreamId: string, enabled: boolean): Promise<void> {
    if (this.baseConfig.upstreams.some((item) => item.id === upstreamId)) {
      throw new GatewayError(409, `Upstream "${upstreamId}" is managed by environment config and cannot be modified from admin UI`);
    }

    const current = this.currentPersistedState.upstreams.find((item) => item.id === upstreamId);
    if (!current) {
      throw new GatewayError(404, `Unknown upstream "${upstreamId}"`);
    }

    await this.saveAndReload({
      ...this.currentPersistedState,
      upstreams: this.currentPersistedState.upstreams.map((item) =>
        item.id === upstreamId ? { ...item, enabled } : item
      )
    });
  }

  public async deleteUpstream(upstreamId: string): Promise<void> {
    if (this.baseConfig.upstreams.some((item) => item.id === upstreamId)) {
      throw new GatewayError(409, `Upstream "${upstreamId}" is managed by environment config and cannot be deleted from admin UI`);
    }

    if (!this.currentPersistedState.upstreams.some((item) => item.id === upstreamId)) {
      throw new GatewayError(404, `Unknown upstream "${upstreamId}"`);
    }

    const referencing = [...this.baseConfig.workspaces, ...this.currentPersistedState.workspaces]
      .filter((workspace) => workspace.upstreamIds?.includes(upstreamId))
      .map((workspace) => workspace.id);

    if (referencing.length > 0) {
      throw new GatewayError(409, `Upstream "${upstreamId}" is still referenced by workspaces`, {
        workspaces: referencing
      });
    }

    await this.saveAndReload({
      ...this.currentPersistedState,
      upstreams: this.currentPersistedState.upstreams.filter((item) => item.id !== upstreamId)
    });
  }

  public async setWorkspaceEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    if (this.baseConfig.workspaces.some((item) => item.id === workspaceId)) {
      throw new GatewayError(409, `Workspace "${workspaceId}" is managed by environment config and cannot be modified from admin UI`);
    }

    const current = this.currentPersistedState.workspaces.find((item) => item.id === workspaceId);
    if (!current) {
      throw new GatewayError(404, `Unknown workspace "${workspaceId}"`);
    }

    await this.saveAndReload({
      ...this.currentPersistedState,
      workspaces: this.currentPersistedState.workspaces.map((item) =>
        item.id === workspaceId ? { ...item, enabled } : item
      )
    });
  }

  public async deleteWorkspace(workspaceId: string): Promise<void> {
    if (this.baseConfig.workspaces.some((item) => item.id === workspaceId)) {
      throw new GatewayError(409, `Workspace "${workspaceId}" is managed by environment config and cannot be deleted from admin UI`);
    }

    if (!this.currentPersistedState.workspaces.some((item) => item.id === workspaceId)) {
      throw new GatewayError(404, `Unknown workspace "${workspaceId}"`);
    }

    await this.saveAndReload({
      ...this.currentPersistedState,
      workspaces: this.currentPersistedState.workspaces.filter((item) => item.id !== workspaceId)
    });
  }

  public async checkUpstreamHealth(upstreamId: string): Promise<{
    ok: boolean;
    upstreamId: string;
    statusCode?: number;
    classification: string;
    message: string;
  }> {
    const upstream = this.mergedConfig.upstreams.find((item) => item.id === upstreamId);
    if (!upstream) {
      throw new GatewayError(404, `Unknown upstream "${upstreamId}"`);
    }

    const probe = this.createHealthProbe(upstream);

    try {
      const response = await fetch(probe.url, {
        method: probe.method,
        headers: probe.headers,
        body: probe.body,
        signal: AbortSignal.timeout(upstream.timeoutMs ?? this.baseConfig.requestTimeoutMs)
      });

      return {
        ok: response.ok || [400, 401, 403, 404, 405].includes(response.status),
        upstreamId,
        statusCode: response.status,
        classification: response.ok ? "ok" : this.classifyHealthStatus(response.status),
        message: this.describeHealthStatus(upstream.kind, response.status)
      };
    } catch (error) {
      return {
        ok: false,
        upstreamId,
        classification: "network_error",
        message: (error as Error).message
      };
    }
  }

  public async completeOAuthConnection(
    pending: PendingOAuthConnection,
    code: string
  ): Promise<UpstreamConfig> {
    const oauth2 = pending.upstream.oauth2;
    if (!oauth2) {
      throw new GatewayError(400, "OAuth connection is missing oauth2 config");
    }

    const tokenParams: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      client_id: oauth2.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier
    };
    if (oauth2.clientSecret) {
      tokenParams.client_secret = oauth2.clientSecret;
    }

    const tokenResponse = await fetch(oauth2.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(tokenParams),
      signal: AbortSignal.timeout(this.baseConfig.requestTimeoutMs)
    });

    if (!tokenResponse.ok) {
      const responseBody = await tokenResponse.text();
      throw new GatewayError(502, `OAuth token exchange failed with status ${tokenResponse.status}: ${responseBody}`, {
        upstreamId: pending.upstream.id,
        body: responseBody
      });
    }

    const tokenPayload = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    if (!tokenPayload.access_token) {
      throw new GatewayError(502, "OAuth token exchange did not return access_token");
    }

    const expiresAt =
      typeof tokenPayload.expires_in === "number"
        ? new Date(Date.now() + tokenPayload.expires_in * 1000).toISOString()
        : undefined;

    const upstream: UpstreamConfig = {
      ...pending.upstream,
      authMode: "oauth2",
      oauth2: {
        ...oauth2,
        accessToken: tokenPayload.access_token,
        refreshToken: tokenPayload.refresh_token,
        expiresAt,
        tokenType: tokenPayload.token_type ?? "Bearer",
        scopes:
          typeof tokenPayload.scope === "string"
            ? tokenPayload.scope.split(" ").filter(Boolean)
            : oauth2.scopes,
        accountId:
          pending.upstream.kind === "openai" && getOpenAIUpstreamMode(pending.upstream) === "codex"
            ? extractChatGPTAccountId(tokenPayload.access_token) ?? oauth2.accountId
            : oauth2.accountId
      }
    };

    const result = await this.upsertOAuthUpstreamByAccountId(upstream);
    const savedUpstream = this.mergedConfig.upstreams.find((item) => item.id === result.upstreamId);
    return savedUpstream ?? {
      ...upstream,
      id: result.upstreamId
    };
  }

  private async saveAndReload(nextState: PersistedGatewayState): Promise<void> {
    this.buildMergedConfig(nextState);
    await this.queuePersistState(nextState);
    this.currentPersistedState = await this.store.load();
    this.currentPersistedState = this.prunePersistedState(this.currentPersistedState);
    this.applyState(this.currentPersistedState);
  }

  private buildMergedConfig(state: PersistedGatewayState): GatewayConfig {
    const combinedUpstreams = [...this.baseConfig.upstreams, ...state.upstreams];
    const combinedWorkspaces = [...this.baseConfig.workspaces, ...state.workspaces];
    const normalized = normalizeWorkspaces(combinedWorkspaces, combinedUpstreams);

    return {
      ...this.baseConfig,
      upstreams: combinedUpstreams,
      workspaces: normalized.workspaces,
      defaultWorkspaceId: normalized.defaultWorkspaceId
    };
  }

  private applyState(state: PersistedGatewayState): void {
    this.currentPersistedState = state;
    this.mergedConfig = this.buildMergedConfig(state);
    this.gateway = this.createGateway(this.mergedConfig);
  }

  private createGateway(config: GatewayConfig): GatewayRouter {
    return new GatewayRouter(
      new UpstreamScheduler(config.upstreams),
      config.modelMap,
      config.upstreams,
      config.workspaces,
      config.defaultWorkspaceId,
      this.currentPersistedState.responseRoutes ?? [],
      this.currentPersistedState.sessionRoutes ?? [],
      (routingState) => this.handleRoutingStateChanged(routingState)
    );
  }

  private handleRoutingStateChanged(routingState: {
    responseRoutes: PersistedResponseRoute[];
    sessionRoutes: PersistedSessionRoute[];
  }): void {
    this.currentPersistedState = {
      ...this.currentPersistedState,
      responseRoutes: routingState.responseRoutes,
      sessionRoutes: routingState.sessionRoutes
    };
    this.scheduleStateFlush();
  }

  private scheduleStateFlush(): void {
    if (this.pendingStateFlushTimer) {
      clearTimeout(this.pendingStateFlushTimer);
    }

    this.pendingStateFlushTimer = setTimeout(() => {
      this.pendingStateFlushTimer = undefined;
      void this.queuePersistState(this.currentPersistedState);
    }, 250);
  }

  private queuePersistState(state: PersistedGatewayState): Promise<void> {
    const snapshot = this.prunePersistedState(state);
    this.stateSaveQueue = this.stateSaveQueue
      .catch(() => undefined)
      .then(async () => {
        await this.store.save(snapshot);
      });
    return this.stateSaveQueue;
  }

  private prunePersistedState(state: PersistedGatewayState): PersistedGatewayState {
    const now = Date.now();
    const responseRoutes = (state.responseRoutes ?? []).filter((route) =>
      route.responseId &&
      route.upstreamId &&
      route.workspaceId &&
      typeof route.expiresAt === "number" &&
      route.expiresAt > now
    );
    const sessionRoutes = (state.sessionRoutes ?? []).filter((route) =>
      route.affinityKey &&
      route.upstreamId &&
      route.workspaceId &&
      typeof route.expiresAt === "number" &&
      route.expiresAt > now
    );

    return {
      upstreams: state.upstreams ?? [],
      workspaces: state.workspaces ?? [],
      responseRoutes,
      sessionRoutes,
      updatedAt: state.updatedAt
    };
  }

  private normalizeAdminUpstream(input: UpstreamConfig): UpstreamConfig {
    if (!input.id?.trim()) {
      throw new GatewayError(400, "`id` is required");
    }

    if (!input.baseUrl?.trim()) {
      throw new GatewayError(400, "`baseUrl` is required");
    }

    const authMode = input.authMode ?? "api_key";
    if (authMode === "api_key" && !input.apiKey?.trim()) {
      throw new GatewayError(400, "`apiKey` is required");
    }

    if (authMode === "oauth2" && !input.oauth2?.accessToken?.trim()) {
      throw new GatewayError(400, "`oauth2.accessToken` is required");
    }

    return {
      ...input,
      id: input.id.trim(),
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      openaiMode: input.kind === "openai" ? getOpenAIUpstreamMode(input) : undefined,
      authMode,
      authHeader: input.authHeader ?? (input.kind === "anthropic" ? "x-api-key" : "authorization_bearer"),
      apiKey: input.apiKey?.trim(),
      oauth2: input.oauth2,
      enabled: input.enabled ?? true,
      models: input.models?.filter(Boolean) ?? [],
      cooldownMs: input.cooldownMs ?? 30_000,
      timeoutMs: input.timeoutMs ?? this.baseConfig.requestTimeoutMs
    };
  }

  private normalizeAdminWorkspace(input: WorkspaceConfig): WorkspaceConfig {
    if (!input.id?.trim()) {
      throw new GatewayError(400, "`id` is required");
    }

    return {
      id: input.id.trim(),
      upstreamIds: input.upstreamIds?.filter(Boolean) ?? [],
      modelMap: input.modelMap ?? {},
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? false
    };
  }

  private createHealthProbe(upstream: UpstreamConfig): {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  } {
    if (upstream.kind === "openai") {
      if (isCodexUpstream(upstream)) {
        const model = upstream.models?.[0];
        if (!model) {
          throw new GatewayError(400, `Codex upstream "${upstream.id}" needs at least one configured model before health checks can run`);
        }

        return {
          method: "POST",
          url: resolveCodexResponsesUrl(upstream.baseUrl),
          headers: Object.fromEntries(buildCodexHeaders(upstream, {
            "content-type": "application/json",
            "openai-beta": "responses=experimental"
          }).entries()),
          body: JSON.stringify({
            model,
            store: false,
            stream: false,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "ping"
                  }
                ]
              }
            ],
            max_output_tokens: 8
          })
        };
      }

      return {
        method: "GET",
        url: `${upstream.baseUrl}/v1/models`,
        headers: {
          ...buildAuthHeaders(upstream, "authorization_bearer"),
          ...upstream.headers
        }
      };
    }

    const model = upstream.models?.[0];
    if (!model) {
      throw new GatewayError(400, `Anthropic-compatible upstream "${upstream.id}" needs at least one configured model before health checks can run`);
    }

    return {
      method: "POST",
      url: `${upstream.baseUrl}/v1/messages/count_tokens`,
      headers: {
        "content-type": "application/json",
        ...buildAuthHeaders(upstream),
        "anthropic-version": "2023-06-01",
        ...upstream.headers
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "ping"
          }
        ]
      })
    };
  }

  private classifyHealthStatus(status: number): string {
    if (status === 401 || status === 403) {
      return "auth_error";
    }

    if (status === 404 || status === 405) {
      return "endpoint_mismatch";
    }

    if (status === 429) {
      return "rate_limited";
    }

    if (status >= 500) {
      return "upstream_error";
    }

    return "response_error";
  }

  private describeHealthStatus(kind: UpstreamConfig["kind"], status: number): string {
    if (status >= 200 && status < 300) {
      return `${kind} upstream responded successfully`;
    }

    if (status === 401 || status === 403) {
      return `${kind} upstream rejected the credentials`;
    }

    if (status === 404 || status === 405) {
      return `${kind} upstream is reachable but the configured base URL may not match the expected API shape`;
    }

    if (status === 429) {
      return `${kind} upstream is reachable but currently rate limited`;
    }

    return `${kind} upstream returned HTTP ${status}`;
  }
}
