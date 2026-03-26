import { createHash, randomBytes } from "node:crypto";

import type { PendingOAuthConnection, UpstreamConfig } from "../types/api.js";

interface StartOAuthInput {
  setupToken: string;
  upstream: UpstreamConfig;
  redirectUri: string;
}

function toBase64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export class OAuthStateManager {
  private readonly states = new Map<string, PendingOAuthConnection>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  public create(input: StartOAuthInput): { state: string; authorizationUrl: string } {
    const state = randomBytes(24).toString("hex");
    const codeVerifier = toBase64Url(randomBytes(32));
    const codeChallenge = toBase64Url(createHash("sha256").update(codeVerifier).digest());

    const pending: PendingOAuthConnection = {
      setupToken: input.setupToken,
      upstream: input.upstream,
      codeVerifier,
      redirectUri: input.redirectUri,
      createdAt: Date.now()
    };

    this.states.set(state, pending);

    const oauth2 = input.upstream.oauth2!;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: oauth2.clientId,
      redirect_uri: input.redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    });

    if (oauth2.scopes?.length) {
      params.set("scope", oauth2.scopes.join(" "));
    }

    const extras = oauth2.authorizeExtraParams;
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        params.set(key, value);
      }
    }

    return {
      state,
      authorizationUrl: `${oauth2.authorizationUrl}?${params.toString()}`
    };
  }

  public consume(state: string): PendingOAuthConnection | undefined {
    const pending = this.states.get(state);
    if (!pending) {
      return undefined;
    }

    if (pending.createdAt + this.ttlMs <= Date.now()) {
      this.states.delete(state);
      return undefined;
    }

    this.states.delete(state);
    return pending;
  }
}
