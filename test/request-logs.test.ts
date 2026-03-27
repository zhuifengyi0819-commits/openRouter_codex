import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";

test("openai request failures are written to logs directory", async () => {
  const previousCwd = process.cwd();
  const previousEnv = {
    PORT: process.env.PORT,
    HOST: process.env.HOST,
    LOG_LEVEL: process.env.LOG_LEVEL,
    REQUEST_LOGGING_ENABLED: process.env.REQUEST_LOGGING_ENABLED,
    DATA_DIR: process.env.DATA_DIR,
    GATEWAY_API_KEYS: process.env.GATEWAY_API_KEYS,
    UPSTREAMS_JSON: process.env.UPSTREAMS_JSON,
    WORKSPACES_JSON: process.env.WORKSPACES_JSON
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-logs-"));

  process.chdir(tempDir);
  process.env.PORT = "3012";
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUEST_LOGGING_ENABLED = "true";
  process.env.DATA_DIR = path.join(tempDir, ".gateway-data");
  process.env.GATEWAY_API_KEYS = "test-key";
  process.env.UPSTREAMS_JSON = JSON.stringify([
    {
      id: "u1",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "sk-test",
      models: ["gpt-5.4"]
    }
  ]);
  process.env.WORKSPACES_JSON = "[]";

  const { buildServer } = await import("../src/server.ts");
  const { app } = await buildServer();

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer wrong-key"
      }
    });

    assert.equal(response.statusCode, 401);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logDir = path.join(tempDir, "logs");
    const files = await readdir(logDir);
    const traceFile = files.find((entry) => entry.endsWith(".jsonl"));
    assert.ok(traceFile, "expected a per-request trace log file");

    const contents = await readFile(path.join(logDir, traceFile), "utf8");
    assert.match(contents, /"stage":"incoming.request"/);
    assert.match(contents, /"stage":"gateway.auth_failed"/);
    assert.match(contents, /"stage":"gateway.response"/);
    assert.match(contents, /invalid_api_key/);
  } finally {
    await app.close();
    process.chdir(previousCwd);

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request trace logging can be disabled", async () => {
  const previousCwd = process.cwd();
  const previousEnv = {
    PORT: process.env.PORT,
    HOST: process.env.HOST,
    LOG_LEVEL: process.env.LOG_LEVEL,
    REQUEST_LOGGING_ENABLED: process.env.REQUEST_LOGGING_ENABLED,
    DATA_DIR: process.env.DATA_DIR,
    GATEWAY_API_KEYS: process.env.GATEWAY_API_KEYS,
    UPSTREAMS_JSON: process.env.UPSTREAMS_JSON,
    WORKSPACES_JSON: process.env.WORKSPACES_JSON
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-logs-disabled-"));

  process.chdir(tempDir);
  process.env.PORT = "3013";
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUEST_LOGGING_ENABLED = "false";
  process.env.DATA_DIR = path.join(tempDir, ".gateway-data");
  process.env.GATEWAY_API_KEYS = "test-key";
  process.env.UPSTREAMS_JSON = JSON.stringify([
    {
      id: "u1",
      kind: "openai",
      baseUrl: "https://example.com",
      apiKey: "sk-test",
      models: ["gpt-5.4"]
    }
  ]);
  process.env.WORKSPACES_JSON = "[]";

  const { buildServer } = await import("../src/server.ts");
  const { app } = await buildServer();

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer wrong-key"
      }
    });

    assert.equal(response.statusCode, 401);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logDir = path.join(tempDir, "logs");
    await assert.rejects(() => readdir(logDir));
  } finally {
    await app.close();
    process.chdir(previousCwd);

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});

test("gateway usage endpoint exposes codex usage summary", async () => {
  const previousCwd = process.cwd();
  const previousEnv = {
    PORT: process.env.PORT,
    HOST: process.env.HOST,
    LOG_LEVEL: process.env.LOG_LEVEL,
    REQUEST_LOGGING_ENABLED: process.env.REQUEST_LOGGING_ENABLED,
    DATA_DIR: process.env.DATA_DIR,
    GATEWAY_API_KEYS: process.env.GATEWAY_API_KEYS,
    UPSTREAMS_JSON: process.env.UPSTREAMS_JSON,
    WORKSPACES_JSON: process.env.WORKSPACES_JSON
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gateway-usage-"));

  process.chdir(tempDir);
  process.env.PORT = "3014";
  process.env.HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "silent";
  process.env.REQUEST_LOGGING_ENABLED = "false";
  process.env.DATA_DIR = path.join(tempDir, ".gateway-data");
  process.env.GATEWAY_API_KEYS = "test-key";
  process.env.UPSTREAMS_JSON = JSON.stringify([
    {
      id: "codex-team-a",
      kind: "openai",
      openaiMode: "codex",
      baseUrl: "https://chatgpt.com/backend-api",
      authMode: "oauth2",
      models: ["gpt-5.4"],
      oauth2: {
        authorizationUrl: "https://auth.openai.com/oauth/authorize",
        tokenUrl: "https://auth.openai.com/oauth/token",
        clientId: "client",
        clientSecret: "secret",
        accessToken: "token",
        accountId: "acct_123",
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    }
  ]);
  process.env.WORKSPACES_JSON = JSON.stringify([
    {
      id: "team-a",
      upstreamIds: ["codex-team-a"],
      isDefault: true
    }
  ]);

  const { buildServer } = await import("../src/server.ts");
  const { app } = await buildServer();

  try {
    const response = await app.inject({
      method: "GET",
      url: "/v1/gateway/usage",
      headers: {
        authorization: "Bearer test-key",
        "x-workspace-id": "team-a"
      }
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.workspaceId, "team-a");
    assert.equal(payload.requestLoggingEnabled, false);
    assert.equal(payload.codex.upstreams, 1);
    assert.equal(payload.upstreams[0]?.id, "codex-team-a");
    assert.equal(payload.upstreams[0]?.openaiMode, "codex");
    assert.equal(payload.upstreams[0]?.oauth2?.accountId, "acct_123");
    assert.equal(typeof payload.upstreams[0]?.quota?.exhausted, "boolean");
  } finally {
    await app.close();
    process.chdir(previousCwd);

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});
