import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SecretStore } from "../src/core/secret-store.js";

test("SecretStore persists response routes alongside upstream state", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "gateway-store-"));
  const store = new SecretStore(dataDir);

  try {
    await store.save({
      upstreams: [],
      workspaces: [],
      responseRoutes: [
        {
          responseId: "resp_123",
          upstreamId: "team-a",
          workspaceId: "default",
          expiresAt: Date.now() + 60_000
        }
      ],
      sessionRoutes: [
        {
          affinityKey: "session:sess_123",
          upstreamId: "team-a",
          workspaceId: "default",
          sessionId: "sess_123",
          promptCacheKey: "sess_123",
          expiresAt: Date.now() + 60_000
        }
      ]
    });

    const state = await store.load();
    assert.equal(state.responseRoutes?.[0]?.responseId, "resp_123");
    assert.equal(state.responseRoutes?.[0]?.upstreamId, "team-a");
    assert.equal(state.sessionRoutes?.[0]?.affinityKey, "session:sess_123");
    assert.equal(state.sessionRoutes?.[0]?.sessionId, "sess_123");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
