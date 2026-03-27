import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";

import type { GatewayRuntime } from "./runtime.js";
import type { UpstreamConfig } from "../types/api.js";

function toOAuthCredentials(upstream: UpstreamConfig): OAuthCredentials | undefined {
  const oauth2 = upstream.oauth2;
  if (!oauth2?.accessToken || !oauth2.refreshToken) {
    return undefined;
  }

  return {
    access: oauth2.accessToken,
    refresh: oauth2.refreshToken,
    expires: oauth2.expiresAt ? new Date(oauth2.expiresAt).getTime() : 0
  };
}

function isExpiringSoon(upstream: UpstreamConfig, marginMs = 5 * 60_000): boolean {
  const expiresAt = upstream.oauth2?.expiresAt;
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() - marginMs < Date.now();
}

export async function ensureFreshToken(
  runtime: GatewayRuntime,
  upstream: UpstreamConfig
): Promise<UpstreamConfig> {
  if (upstream.authMode !== "oauth2") return upstream;
  if (!isExpiringSoon(upstream)) return upstream;

  const creds = toOAuthCredentials(upstream);
  if (!creds) return upstream;

  const provider = getOAuthProvider("openai-codex");
  if (!provider) {
    console.log(`[token-refresh] No pi-ai provider for openai-codex, skipping refresh`);
    return upstream;
  }

  try {
    console.log(`[token-refresh] Refreshing token for ${upstream.id}...`);
    const newCreds = await provider.refreshToken(creds);

    const updated: UpstreamConfig = {
      ...upstream,
      oauth2: {
        ...upstream.oauth2!,
        accessToken: newCreds.access,
        refreshToken: newCreds.refresh,
        expiresAt: new Date(newCreds.expires).toISOString(),
        accountId:
          "accountId" in newCreds && typeof newCreds.accountId === "string"
            ? newCreds.accountId
            : upstream.oauth2?.accountId
      }
    };

    await runtime.upsertUpstream(updated);
    console.log(`[token-refresh] ✅ ${upstream.id} refreshed, expires ${updated.oauth2!.expiresAt}`);
    return updated;
  } catch (err) {
    console.log(`[token-refresh] ❌ ${upstream.id} refresh failed: ${(err as Error).message}`);
    return upstream;
  }
}

export function startTokenRefreshLoop(runtime: GatewayRuntime, intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(async () => {
    const upstreams = runtime.getConfig().upstreams.filter((u) => u.authMode === "oauth2");
    for (const upstream of upstreams) {
      if (isExpiringSoon(upstream)) {
        await ensureFreshToken(runtime, upstream);
      }
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
