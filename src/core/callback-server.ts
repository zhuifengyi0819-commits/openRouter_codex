import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

export interface CallbackResult {
  code: string;
  state: string;
  raw: Record<string, string>;
}

/**
 * Spins up a minimal HTTP server that waits for a single OAuth callback,
 * then resolves with the query parameters and shuts itself down.
 */
export function startCallbackServer(
  port: number,
  path: string
): { url: string; result: Promise<CallbackResult>; close: () => void } {
  let server: Server;
  let settled = false;

  const result = new Promise<CallbackResult>((resolve, reject) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const parsed = new URL(req.url ?? "/", `http://localhost:${port}`);

      if (parsed.pathname !== path) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }

      const raw: Record<string, string> = {};
      for (const [key, value] of parsed.searchParams.entries()) {
        raw[key] = value;
      }

      const error = raw.error;
      if (error) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<h2>OAuth Error</h2><p>${error}</p><p>You can close this tab.</p>`);
        if (!settled) {
          settled = true;
          reject(new Error(`Provider returned error: ${error}`));
        }
        closeServer();
        return;
      }

      const code = raw.code;
      const state = raw.state ?? "";

      if (!code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end("<h2>Missing code</h2><p>Callback did not contain an authorization code.</p>");
        if (!settled) {
          settled = true;
          reject(new Error("Callback did not contain an authorization code"));
        }
        closeServer();
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h2>Login successful!</h2><p>Token is being exchanged. You can close this tab.</p>");

      if (!settled) {
        settled = true;
        resolve({ code, state, raw });
      }
      closeServer();
    });

    server.listen(port, "127.0.0.1", () => {
      /* ready */
    });

    server.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });

  function closeServer() {
    try {
      server?.close();
    } catch {
      /* best-effort */
    }
  }

  return {
    url: `http://localhost:${port}${path}`,
    result,
    close: closeServer
  };
}

export class OAuthCallbackRelay {
  private server: Server | undefined;
  private targetOrigin: string | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(
    private readonly port: number,
    private readonly path: string
  ) {}

  public async ensureStarted(targetOrigin: string): Promise<string> {
    this.targetOrigin = targetOrigin.replace(/\/+$/, "");
    if (this.server) {
      return this.getLocalUrl();
    }

    if (!this.startPromise) {
      this.startPromise = new Promise<void>((resolve, reject) => {
        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
          const parsed = new URL(req.url ?? "/", `http://localhost:${this.port}`);
          if (parsed.pathname !== this.path) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Not found");
            return;
          }

          if (!this.targetOrigin) {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("OAuth callback relay is not configured");
            return;
          }

          const forwardUrl = `${this.targetOrigin}${this.path}${parsed.search}`;
          res.writeHead(302, { location: forwardUrl });
          res.end("Redirecting back to gateway admin...");
        });

        server.once("error", (error) => {
          this.startPromise = undefined;
          reject(error);
        });

        server.listen(this.port, "127.0.0.1", () => {
          this.server = server;
          resolve();
        });
      });
    }

    await this.startPromise;
    return this.getLocalUrl();
  }

  public close(): void {
    try {
      this.server?.close();
    } catch {
      /* best-effort */
    }
    this.server = undefined;
    this.startPromise = undefined;
  }

  private getLocalUrl(): string {
    return `http://localhost:${this.port}${this.path}`;
  }
}
