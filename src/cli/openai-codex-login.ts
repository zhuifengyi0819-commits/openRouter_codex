import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  buildCodexAuthorizeExtraParams,
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_SCOPES,
  CODEX_OAUTH_TOKEN_URL
} from "../core/codex-oauth.js";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export interface CodexOAuthAuthInfo {
  url: string;
  instructions?: string;
}

export interface CodexOAuthPrompt {
  message: string;
  placeholder?: string;
}

export interface CodexOAuthLoginCallbacks {
  onAuth: (info: CodexOAuthAuthInfo) => void;
  onPrompt: (prompt: CodexOAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
}

export interface CodexOAuthLoginOptions extends CodexOAuthLoginCallbacks {
  callbackPort: number;
  forceLoginPrompt?: boolean;
  originator?: string;
}

interface OAuthWaitResult {
  code?: string;
}

interface LocalCallbackServerHandle {
  waitForCode: () => Promise<OAuthWaitResult | null>;
  close: () => Promise<void>;
}

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) {
    return {};
  }

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined
    };
  } catch {
    // not a URL
  }

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined
    };
  }

  return { code: value };
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }

    return JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  if (!auth || typeof auth !== "object") {
    return null;
  }

  const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

function createAuthorizationFlow(options: {
  callbackPort: number;
  originator?: string;
  forceLoginPrompt?: boolean;
}) {
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${options.callbackPort}/auth/callback`;

  return generatePKCE().then(({ verifier, challenge }) => {
    const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", CODEX_OAUTH_SCOPES.join(" "));
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    const extraParams = buildCodexAuthorizeExtraParams(options.forceLoginPrompt === true);
    extraParams.originator = options.originator ?? extraParams.originator;
    for (const [key, value] of Object.entries(extraParams)) {
      url.searchParams.set(key, value);
    }

    return {
      verifier,
      state,
      redirectUri,
      url: url.toString()
    };
  });
}

function startLocalCallbackServer(state: string, port: number): Promise<LocalCallbackServerHandle> {
  let settleWait: ((value: OAuthWaitResult | null) => void) | undefined;
  const waitForCodePromise = new Promise<OAuthWaitResult | null>((resolve) => {
    settleWait = resolve;
  });

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== "/auth/callback") {
        res.statusCode = 404;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html><body><h1>Callback route not found.</h1></body></html>");
        return;
      }

      if (url.searchParams.get("state") !== state) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html><body><h1>State mismatch.</h1></body></html>");
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<html><body><h1>Missing authorization code.</h1></body></html>");
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><body><h1>OpenAI authentication completed.</h1><p>You can close this window.</p></body></html>");
      settleWait?.({ code });
    } catch {
      res.statusCode = 500;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<html><body><h1>Internal callback error.</h1></body></html>");
    }
  });

  return new Promise((resolve) => {
    server
      .listen(port, "127.0.0.1", () => {
        resolve({
          waitForCode: () => waitForCodePromise,
          close: async () => {
            settleWait?.(null);
            await closeServer(server);
          }
        });
      })
      .on("error", () => {
        settleWait?.(null);
        resolve({
          waitForCode: async () => null,
          close: async () => {
            try {
              await closeServer(server);
            } catch {
              // ignore
            }
          }
        });
      });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function exchangeAuthorizationCode(code: string, verifier: string, redirectUri: string): Promise<CodexOAuthCredentials> {
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${body || response.statusText}`);
  }

  const json = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("Token exchange response is missing required fields");
  }

  const accountId = getAccountId(json.access_token);
  if (!accountId) {
    throw new Error("Failed to extract accountId from token");
  }

  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId
  };
}

export async function loginOpenAICodex(options: CodexOAuthLoginOptions): Promise<CodexOAuthCredentials> {
  const flow = await createAuthorizationFlow({
    callbackPort: options.callbackPort,
    originator: options.originator,
    forceLoginPrompt: options.forceLoginPrompt
  });

  const server = await startLocalCallbackServer(flow.state, options.callbackPort);

  try {
    options.onAuth({
      url: flow.url,
      instructions: options.forceLoginPrompt
        ? "A browser window should open. Re-authenticate and choose the target Team/organization."
        : "A browser window should open. Complete login to finish."
    });

    let code: string | undefined;
    const result = await server.waitForCode();
    if (result?.code) {
      code = result.code;
    }

    if (!code) {
      options.onProgress?.("Browser callback did not complete automatically. Waiting for manual paste.");
      const input = await options.onPrompt({
        message: "Paste the authorization code or the full redirect URL:"
      });
      const parsed = parseAuthorizationInput(input);
      if (parsed.state && parsed.state !== flow.state) {
        throw new Error("State mismatch");
      }
      code = parsed.code;
    }

    if (!code) {
      throw new Error("Missing authorization code");
    }

    return await exchangeAuthorizationCode(code, flow.verifier, flow.redirectUri);
  } finally {
    await server.close();
  }
}
