import { GatewayError } from "./http-error.js";
import type { UpstreamAuthHeader, UpstreamConfig } from "../types/api.js";

export function getUpstreamSecret(upstream: UpstreamConfig): string {
  if ((upstream.authMode ?? "api_key") === "oauth2") {
    if (!upstream.oauth2?.accessToken) {
      throw new GatewayError(500, `Upstream "${upstream.id}" is missing oauth2 access token`);
    }

    return upstream.oauth2.accessToken;
  }

  if (!upstream.apiKey) {
    throw new GatewayError(500, `Upstream "${upstream.id}" is missing apiKey`);
  }

  return upstream.apiKey;
}

export function buildAuthHeaders(upstream: UpstreamConfig, preferredHeader?: UpstreamAuthHeader): Record<string, string> {
  const secret = getUpstreamSecret(upstream);
  const authHeader = preferredHeader ?? upstream.authHeader ?? (upstream.kind === "anthropic" ? "x-api-key" : "authorization_bearer");

  if (authHeader === "x-api-key") {
    return {
      "x-api-key": secret
    };
  }

  return {
    authorization: `Bearer ${secret}`
  };
}
