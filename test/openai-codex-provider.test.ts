import test from "node:test";
import assert from "node:assert/strict";

import { OpenAICodexProvider } from "../src/providers/openai-codex.provider.js";
import type { UpstreamConfig } from "../src/types/api.js";

const upstream: UpstreamConfig = {
  id: "codex-team",
  kind: "openai",
  openaiMode: "codex",
  baseUrl: "https://chatgpt.com/backend-api",
  authMode: "oauth2",
  oauth2: {
    authorizationUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    clientId: "client",
    clientSecret: "secret",
    accessToken: [
      "eyJhbGciOiJub25lIn0",
      "eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0",
      "sig"
    ].join(".")
  },
  models: ["gpt-5.4"]
};

function createSseResponse(chunks: string[]): Response {
  return new Response(chunks.join(""), {
    status: 200,
    headers: {
      "content-type": "text/event-stream"
    }
  });
}

test("chat completion request preserves tools and multimodal inputs", async () => {
  const provider = new OpenAICodexProvider();
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  let requestHeaders: Headers | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestHeaders = new Headers(init?.headers);
    return createSseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"done"}]}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}\n\n'
    ]);
  };

  try {
    const response = await provider.createChatCompletion(upstream, {
      model: "gpt-5.4",
      stream: false,
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" },
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_weather",
            description: "Lookup current weather",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" }
              },
              required: ["city"]
            },
            strict: true
          }
        }
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "lookup_weather"
        }
      },
      parallel_tool_calls: false,
      messages: [
        { role: "system", content: "You are helpful." },
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize these inputs." },
            { type: "image_url", image_url: { url: "https://example.com/cat.png", detail: "high" } },
            { type: "input_audio", input_audio: { data: "BASE64AUDIO", format: "wav" } },
            { type: "input_file", file_id: "file_123" }
          ]
        },
        {
          role: "assistant",
          content: "Calling a tool.",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: "{\"city\":\"Shanghai\"}"
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: "Cloudy, 24C" }]
        }
      ]
    }, {
      sessionId: "sess_123",
      promptCacheKey: "cache_123"
    });

    assert.equal(response.status, 200);
    assert.ok(requestBody);
    assert.equal(requestHeaders?.get("session_id"), "sess_123");
    assert.equal(requestBody?.instructions, "You are helpful.");
    assert.deepEqual(requestBody?.modalities, ["text", "audio"]);
    assert.deepEqual(requestBody?.audio, { voice: "alloy", format: "wav" });
    assert.equal(requestBody?.prompt_cache_key, "cache_123");
    assert.equal(requestBody?.parallel_tool_calls, false);
    assert.deepEqual(requestBody?.tool_choice, {
      type: "function",
      name: "lookup_weather"
    });

    const tools = requestBody?.tools as Array<Record<string, unknown>>;
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "lookup_weather");
    assert.equal(tools[0]?.strict, true);

    const input = requestBody?.input as Array<Record<string, unknown>>;
    assert.equal(input.length, 4);
    assert.equal(input[0]?.role, "user");
    assert.deepEqual((input[0]?.content as Array<Record<string, unknown>>).map((part) => part.type), [
      "input_text",
      "input_image",
      "input_audio",
      "input_file"
    ]);
    assert.equal(input[2]?.type, "function_call");
    assert.equal(input[3]?.type, "function_call_output");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responses request falls back to session id as prompt cache key", async () => {
  const provider = new OpenAICodexProvider();
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  let requestHeaders: Headers | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ id: "resp_cache" }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  };

  try {
    const response = await provider.createResponse(upstream, {
      model: "gpt-5.4",
      input: "hello"
    }, {
      sessionId: "sess_cache"
    });

    assert.equal(response.status, 200);
    assert.equal(requestHeaders?.get("session_id"), "sess_cache");
    assert.equal(requestBody?.prompt_cache_key, "sess_cache");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chat completion stream maps codex function calls to tool call deltas", async () => {
  const provider = new OpenAICodexProvider();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    createSseResponse([
      'data: {"type":"response.created","response":{"id":"resp_tool"}}\n\n',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":""}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather"},"delta":"{\\"city\\":\\"Sh"}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather"},"delta":"anghai\\"}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":"{\\"city\\":\\"Shanghai\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}\n\n'
    ]);

  try {
    const response = await provider.createChatCompletion(upstream, {
      model: "gpt-5.4",
      stream: true,
      messages: [{ role: "user", content: "weather?" }]
    });

    const text = await response.text();
    assert.ok(text.includes('"tool_calls":[{"index":0,"id":"call_1","type":"function"'));
    assert.ok(text.includes('"arguments":"{\\"city\\":\\"Sh"'));
    assert.ok(text.includes('"arguments":"anghai\\\\\\"}"') || text.includes('"arguments":"anghai\\"}"'));
    assert.ok(text.includes('"finish_reason":"tool_calls"'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-stream chat completion returns tool_calls in final message", async () => {
  const provider = new OpenAICodexProvider();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    createSseResponse([
      'data: {"type":"response.created","response":{"id":"resp_tool_final"}}\n\n',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":""}}\n\n',
      'data: {"type":"response.function_call_arguments.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather"},"arguments":"{\\"city\\":\\"Shanghai\\"}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":"{\\"city\\":\\"Shanghai\\"}"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_tool_final","status":"completed","usage":{"input_tokens":8,"output_tokens":3,"total_tokens":11}}}\n\n'
    ]);

  try {
    const response = await provider.createChatCompletion(upstream, {
      model: "gpt-5.4",
      stream: false,
      messages: [{ role: "user", content: "weather?" }]
    });

    const payload = await response.json() as {
      choices: Array<{
        finish_reason: string;
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
      }>;
    };

    assert.equal(payload.choices[0]?.finish_reason, "tool_calls");
    assert.equal(payload.choices[0]?.message.content, null);
    assert.equal(payload.choices[0]?.message.tool_calls?.[0]?.id, "call_1");
    assert.equal(payload.choices[0]?.message.tool_calls?.[0]?.function.name, "lookup_weather");
    assert.equal(payload.choices[0]?.message.tool_calls?.[0]?.function.arguments, "{\"city\":\"Shanghai\"}");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
