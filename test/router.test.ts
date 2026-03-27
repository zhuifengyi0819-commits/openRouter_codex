import test from "node:test";
import assert from "node:assert/strict";

import { GatewayRouter } from "../src/core/router.js";
import { UpstreamScheduler } from "../src/core/scheduler.js";
import type { PersistedResponseRoute, PersistedSessionRoute, UpstreamConfig, WorkspaceConfig } from "../src/types/api.js";

function createRouter(options?: {
  persistedResponseRoutes?: PersistedResponseRoute[];
  persistedSessionRoutes?: PersistedSessionRoute[];
  onRoutingStateChanged?: (state: {
    responseRoutes: PersistedResponseRoute[];
    sessionRoutes: PersistedSessionRoute[];
  }) => void;
}): GatewayRouter {
  const upstreams: UpstreamConfig[] = [
    {
      id: "team-a",
      kind: "openai",
      baseUrl: "https://team-a.example.com",
      authMode: "api_key",
      apiKey: "a",
      models: ["gpt-5.4"],
      enabled: true
    },
    {
      id: "team-b",
      kind: "openai",
      baseUrl: "https://team-b.example.com",
      authMode: "api_key",
      apiKey: "b",
      models: ["gpt-5.4"],
      enabled: true
    }
  ];

  const workspaces: WorkspaceConfig[] = [
    {
      id: "default",
      upstreamIds: upstreams.map((upstream) => upstream.id),
      enabled: true,
      isDefault: true
    }
  ];

  return new GatewayRouter(
    new UpstreamScheduler(upstreams),
    {},
    upstreams,
    workspaces,
    "default",
    options?.persistedResponseRoutes ?? [],
    options?.persistedSessionRoutes ?? [],
    options?.onRoutingStateChanged
  );
}

test("dispatchOpenAIResponses retries another upstream on 429", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const router = createRouter();

  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://team-a.example.com")) {
      return new Response(JSON.stringify({
        error: {
          message: "insufficient_quota"
        }
      }), {
        status: 429,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    return new Response(JSON.stringify({
      id: "resp_ok",
      usage: {
        prompt_tokens: 7,
        completion_tokens: 5,
        total_tokens: 12
      }
    }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    const result = await router.dispatchOpenAIResponses({ model: "gpt-5.4" }, {}, "default");
    assert.equal(result.upstream.id, "team-b");
    assert.deepEqual(calls, [
      "https://team-a.example.com/v1/responses",
      "https://team-b.example.com/v1/responses"
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const snapshot = router.getSchedulerSnapshot();
    assert.equal(snapshot.find((item) => item.id === "team-a")?.totalRequests, 1);
    assert.equal(snapshot.find((item) => item.id === "team-b")?.totalRequests, 1);
    assert.equal(snapshot.find((item) => item.id === "team-b")?.usage.totalTokens, 12);
    assert.ok((snapshot.find((item) => item.id === "team-b")?.latency.lastMs ?? -1) >= 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchOpenAI normalizes chat body before sending upstream", async () => {
  const originalFetch = globalThis.fetch;
  const router = createRouter();
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "chat_ok" }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    await router.dispatchOpenAI({
      model: "gpt-5.4",
      input: "hello",
      session_id: "sess_internal",
      prompt_cache_key: "cache_internal",
      functions: [
        {
          name: "lookup_weather",
          description: "Lookup weather",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" }
            }
          }
        }
      ],
      function_call: {
        name: "lookup_weather"
      },
      response_format: "json_object",
      max_output_tokens: 128
    }, {}, "default");

    assert.ok(requestBody);
    assert.equal(requestBody?.model, "gpt-5.4");
    assert.equal(requestBody?.session_id, undefined);
    assert.equal(requestBody?.prompt_cache_key, undefined);
    assert.equal(requestBody?.max_output_tokens, undefined);
    assert.equal(requestBody?.max_completion_tokens, 128);
    assert.deepEqual(requestBody?.response_format, { type: "json_object" });
    assert.deepEqual(requestBody?.messages, [
      {
        role: "user",
        content: "hello"
      }
    ]);
    assert.deepEqual(requestBody?.tool_choice, {
      type: "function",
      function: {
        name: "lookup_weather"
      }
    });
    assert.deepEqual(requestBody?.tools, [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Lookup weather",
          parameters: {
            type: "object",
            properties: {
              city: { type: "string" }
            }
          }
        }
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchOpenAIResponses normalizes chat-style body before sending upstream", async () => {
  const originalFetch = globalThis.fetch;
  const router = createRouter();
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "resp_ok" }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    await router.dispatchOpenAIResponses({
      model: "gpt-5.4",
      session_id: "sess_internal",
      max_tokens: 64,
      response_format: "json_object",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" }
      ]
    }, {}, "default");

    assert.ok(requestBody);
    assert.equal(requestBody?.session_id, undefined);
    assert.equal(requestBody?.messages, undefined);
    assert.equal(requestBody?.max_tokens, undefined);
    assert.equal(requestBody?.max_output_tokens, 64);
    assert.deepEqual(requestBody?.text, {
      format: { type: "json_object" }
    });
    assert.equal(requestBody?.instructions, "You are helpful.");
    assert.deepEqual(requestBody?.input, [
      {
        role: "user",
        content: "hello"
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispatchOpenAIEmbeddings strips gateway-only fields before sending upstream", async () => {
  const originalFetch = globalThis.fetch;
  const router = createRouter();
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    await router.dispatchOpenAIEmbeddings({
      model: "gpt-5.4",
      input: "hello",
      session_id: "sess_internal",
      prompt_cache_key: "cache_internal",
      encodingFormat: "float",
      metadata: {
        session_id: "nested_session",
        prompt_cache_key: "nested_cache",
        user: "demo"
      }
    }, {}, "default");

    assert.ok(requestBody);
    assert.equal(requestBody?.session_id, undefined);
    assert.equal(requestBody?.prompt_cache_key, undefined);
    assert.equal(requestBody?.encodingFormat, undefined);
    assert.equal(requestBody?.encoding_format, "float");
    assert.deepEqual(requestBody?.metadata, {
      user: "demo"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming responses remember the upstream before follow-up GET", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const persistedSnapshots: Array<{
    responseRoutes: PersistedResponseRoute[];
    sessionRoutes: PersistedSessionRoute[];
  }> = [];
  const router = createRouter({
    onRoutingStateChanged(state) {
      persistedSnapshots.push(state);
    }
  });

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);

    if (url.endsWith("/v1/responses")) {
      return new Response(
        [
          'data: {"type":"response.created","response":{"id":"resp_stream"}}\n\n',
          'data: {"type":"response.completed","response":{"id":"resp_stream","status":"completed"}}\n\n',
          "data: [DONE]\n\n"
        ].join(""),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream"
          }
        }
      );
    }

    if (url === "https://team-a.example.com/v1/responses/resp_stream") {
      return new Response(JSON.stringify({ id: "resp_stream" }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    return new Response(JSON.stringify({
      error: {
        message: "missing"
      }
    }), {
      status: 404,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    await router.dispatchOpenAIResponses({ model: "gpt-5.4", stream: true }, {}, "default");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const result = await router.dispatchOpenAIResponseItem("GET", "resp_stream", {}, "default");
    assert.equal(result.upstream.id, "team-a");
    assert.ok(
      calls.includes("GET https://team-a.example.com/v1/responses/resp_stream"),
      "expected sticky GET to go directly to the original upstream"
    );
    assert.equal(
      calls.findIndex((entry) => entry === "GET https://team-a.example.com/v1/responses/resp_stream"),
      calls.lastIndexOf("GET https://team-a.example.com/v1/responses/resp_stream")
    );
    assert.equal(persistedSnapshots.at(-1)?.responseRoutes[0]?.responseId, "resp_stream");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("same session stays pinned to the same upstream for better cache locality", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const persistedSnapshots: Array<{
    responseRoutes: PersistedResponseRoute[];
    sessionRoutes: PersistedSessionRoute[];
  }> = [];
  const router = createRouter({
    onRoutingStateChanged(state) {
      persistedSnapshots.push(state);
    }
  });

  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return new Response(JSON.stringify({ id: `resp_${calls.length}` }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    const first = await router.dispatchOpenAIResponses(
      { model: "gpt-5.4", input: "hello", session_id: "sess_same" },
      {},
      "default"
    );
    const second = await router.dispatchOpenAIResponses(
      { model: "gpt-5.4", input: "hello again", session_id: "sess_same" },
      {},
      "default"
    );

    assert.equal(first.upstream.id, "team-a");
    assert.equal(second.upstream.id, "team-a");
    assert.deepEqual(calls, [
      "https://team-a.example.com/v1/responses",
      "https://team-a.example.com/v1/responses"
    ]);
    assert.equal(persistedSnapshots.at(-1)?.sessionRoutes[0]?.affinityKey, "session:sess_same");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
