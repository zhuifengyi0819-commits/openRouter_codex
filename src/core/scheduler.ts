import { GatewayError } from "./http-error.js";
import { CooldownWindow } from "./rate-limit.js";
import type { UpstreamConfig, UpstreamKind, UpstreamOperation, UpstreamState } from "../types/api.js";

interface MatchParams {
  kind: UpstreamKind;
  model: string;
  allowedUpstreamIds?: string[];
}

interface RequestObservation {
  operation: UpstreamOperation;
  latencyMs?: number;
}

interface UsageObservation {
  operation: UpstreamOperation;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export class UpstreamScheduler {
  private readonly cooldowns = new CooldownWindow();
  private readonly state = new Map<string, UpstreamState>();
  private readonly cursorByKind = new Map<UpstreamKind, number>();

  constructor(private readonly upstreams: UpstreamConfig[]) {
    for (const upstream of upstreams) {
      this.state.set(upstream.id, {
        id: upstream.id,
        kind: upstream.kind,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        networkErrors: 0,
        consecutiveFailures: 0,
        requestCounts: {
          chatCompletions: 0,
          responses: 0,
          responseItems: 0,
          embeddings: 0,
          anthropicMessages: 0,
          proxy: 0
        },
        latency: {
          samples: 0
        },
        usage: {
          requestsWithUsage: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }
      });
    }
  }

  public choose(params: MatchParams): UpstreamConfig {
    return this.orderCandidates(params)[0]!;
  }

  public orderCandidates(params: MatchParams, excludedUpstreamIds: string[] = []): UpstreamConfig[] {
    const allowedUpstreamIds = params.allowedUpstreamIds ? new Set(params.allowedUpstreamIds) : undefined;
    const excluded = excludedUpstreamIds.length > 0 ? new Set(excludedUpstreamIds) : undefined;
    const matches = this.upstreams.filter((upstream) => {
      if (allowedUpstreamIds && !allowedUpstreamIds.has(upstream.id)) {
        return false;
      }

      if (excluded && excluded.has(upstream.id)) {
        return false;
      }

      if (upstream.enabled === false) {
        return false;
      }

      if (upstream.kind !== params.kind) {
        return false;
      }

      if (params.model === "*") return true;
      return !upstream.models?.length || upstream.models.includes(params.model);
    });

    if (matches.length === 0) {
      throw new GatewayError(503, `No upstream available for ${params.kind} model "${params.model}"`);
    }

    const available = matches.filter((upstream) => !this.cooldowns.isBlocked(upstream.id));
    if (available.length === 0) {
      const retryAfterMs = Math.min(...matches.map((upstream) => this.cooldowns.remainingMs(upstream.id)));
      throw new GatewayError(503, `All matching upstreams are cooling down`, {
        retryAfterMs
      });
    }

    const cursor = this.cursorByKind.get(params.kind) ?? 0;
    const start = cursor % available.length;
    const ordered = available.slice(start).concat(available.slice(0, start));
    this.cursorByKind.set(params.kind, (cursor + 1) % available.length);
    return ordered;
  }

  public markSuccess(upstreamId: string, status: number, observation?: RequestObservation): void {
    const current = this.getState(upstreamId);
    this.recordObservation(current, observation);
    current.successfulRequests += 1;
    current.consecutiveFailures = 0;
    current.lastStatus = status;
    current.lastError = undefined;
    current.blockedUntil = undefined;
    current.lastSuccessAt = Date.now();
    this.cooldowns.clear(upstreamId);
  }

  public markFailure(
    upstream: UpstreamConfig,
    status: number,
    message?: string,
    observation?: RequestObservation
  ): void {
    const current = this.getState(upstream.id);
    this.recordObservation(current, observation);
    current.failedRequests += 1;
    current.consecutiveFailures += 1;
    current.lastStatus = status;
    current.lastError = message;
    current.lastFailureAt = Date.now();

    if (status === 429) {
      if (this.isQuotaExhausted(message)) {
        const cooldownMs = Math.max(upstream.cooldownMs ?? 30_000, 10 * 60_000);
        console.log(`[scheduler] quota exhausted on ${upstream.id}, cooling down ${cooldownMs}ms`);
        current.blockedUntil = this.cooldowns.block(upstream.id, cooldownMs);
        return;
      }

      const cooldownMs = upstream.cooldownMs ?? 30_000;
      console.log(`[scheduler] 429 from ${upstream.id}, cooling down ${cooldownMs}ms`);
      current.blockedUntil = this.cooldowns.block(upstream.id, cooldownMs);
      return;
    }

    if (status >= 500) {
      const backoffMs = Math.min(30_000, current.consecutiveFailures * 5_000);
      current.blockedUntil = this.cooldowns.block(upstream.id, backoffMs);
      return;
    }

    current.blockedUntil = undefined;
  }

  public markNetworkError(upstream: UpstreamConfig, error: Error, observation?: RequestObservation): void {
    const current = this.getState(upstream.id);
    this.recordObservation(current, observation);
    current.failedRequests += 1;
    current.networkErrors += 1;
    current.consecutiveFailures += 1;
    current.lastError = error.message;
    current.lastStatus = 502;
    current.lastFailureAt = Date.now();
    current.blockedUntil = this.cooldowns.block(upstream.id, 10_000);
  }

  public recordUsage(upstreamId: string, usage: UsageObservation): void {
    const current = this.getState(upstreamId);
    current.lastOperation = usage.operation;
    current.usage.requestsWithUsage += 1;
    current.usage.promptTokens += usage.promptTokens;
    current.usage.completionTokens += usage.completionTokens;
    current.usage.totalTokens += usage.totalTokens;
    current.usage.lastUpdatedAt = Date.now();
  }

  public snapshot(): UpstreamState[] {
    return Array.from(this.state.values()).map((entry) => ({
      ...entry,
      blockedUntil: this.cooldowns.isBlocked(entry.id)
        ? Date.now() + this.cooldowns.remainingMs(entry.id)
        : undefined
    }));
  }

  public snapshotByIds(upstreamIds: string[]): UpstreamState[] {
    const allowed = new Set(upstreamIds);
    return this.snapshot().filter((entry) => allowed.has(entry.id));
  }

  private getState(upstreamId: string): UpstreamState {
    const state = this.state.get(upstreamId);
    if (!state) {
      throw new Error(`Unknown upstream "${upstreamId}"`);
    }

    return state;
  }

  private recordObservation(current: UpstreamState, observation?: RequestObservation): void {
    current.totalRequests += 1;
    current.lastRequestAt = Date.now();
    if (!observation) {
      return;
    }

    current.lastOperation = observation.operation;
    this.incrementOperationCount(current, observation.operation);

    if (typeof observation.latencyMs === "number" && Number.isFinite(observation.latencyMs)) {
      current.latency.samples += 1;
      current.latency.lastMs = observation.latencyMs;
      current.latency.maxMs = Math.max(current.latency.maxMs ?? 0, observation.latencyMs);
      current.latency.avgMs =
        current.latency.samples === 1
          ? observation.latencyMs
          : (((current.latency.avgMs ?? 0) * (current.latency.samples - 1)) + observation.latencyMs) / current.latency.samples;
    }
  }

  private incrementOperationCount(current: UpstreamState, operation: UpstreamOperation): void {
    switch (operation) {
      case "chat_completions":
        current.requestCounts.chatCompletions += 1;
        return;
      case "responses":
        current.requestCounts.responses += 1;
        return;
      case "response_item":
        current.requestCounts.responseItems += 1;
        return;
      case "embeddings":
        current.requestCounts.embeddings += 1;
        return;
      case "anthropic_messages":
        current.requestCounts.anthropicMessages += 1;
        return;
      case "proxy":
        current.requestCounts.proxy += 1;
        return;
    }
  }

  private isQuotaExhausted(message?: string): boolean {
    if (!message) {
      return false;
    }

    const normalized = message.toLowerCase();
    return normalized.includes("insufficient_quota") || normalized.includes("exceeded your current quota");
  }
}
