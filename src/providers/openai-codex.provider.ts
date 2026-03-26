import type { OpenAIChatCompletionRequest, UpstreamConfig } from "../types/api.js";
import { buildCodexHeaders, resolveCodexProxyUrl, resolveCodexResponsesUrl } from "../core/openai-upstream.js";
import { GatewayError } from "../core/http-error.js";

interface CodexEvent {
  type?: string;
  [key: string]: unknown;
}

interface ChatCompletionToolCallAggregate {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface ChatCompletionAggregate {
  id: string;
  created: number;
  model: string;
  content: string;
  refusal?: string;
  finishReason: "stop" | "length" | "tool_calls";
  toolCalls: ChatCompletionToolCallAggregate[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface CodexRequestOptions {
  sessionId?: string;
  promptCacheKey?: string;
}

function createSyntheticId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringifyFallback(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseAssistantContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  const parts = getArray(content);
  if (parts.length === 0) {
    return "";
  }

  return parts
    .map((part) => {
      const item = toObject(part);
      if (!item) {
        return "";
      }

      const type = getString(item.type);
      if (type === "text" || type === "output_text") {
        return getString(item.text) ?? "";
      }
      if (type === "refusal") {
        return getString(item.refusal) ?? "";
      }
      return "";
    })
    .join("");
}

function normalizeImageUrl(value: unknown): { url?: string; detail?: string } {
  if (typeof value === "string") {
    return { url: value };
  }

  const item = toObject(value);
  return {
    url: getString(item?.url),
    detail: getString(item?.detail)
  };
}

function normalizeAudioValue(value: unknown): Record<string, unknown> | undefined {
  const audio = toObject(value);
  if (!audio) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of ["data", "format", "transcript", "url"]) {
    const item = audio[key];
    if (typeof item === "string" && item.length > 0) {
      normalized[key] = item;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeFileValue(value: unknown): Record<string, unknown> | undefined {
  const file = toObject(value);
  if (!file) {
    return undefined;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of ["file_id", "file_data", "filename", "url"]) {
    const item = file[key];
    if (typeof item === "string" && item.length > 0) {
      normalized[key] = item;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseInputContentPart(part: unknown): Record<string, unknown> | undefined {
  const item = toObject(part);
  if (!item) {
    return undefined;
  }

  const type = getString(item.type);
  if (type === "text" || type === "input_text") {
    return {
      type: "input_text",
      text: getString(item.text) ?? ""
    };
  }

  if (type === "image_url") {
    const image = normalizeImageUrl(item.image_url);
    if (image.url) {
      return {
        type: "input_image",
        image_url: image.url,
        detail: image.detail ?? "auto"
      };
    }
    return undefined;
  }

  if (type === "input_image") {
    const image = normalizeImageUrl(item.image_url ?? item.url);
    if (image.url) {
      return {
        type: "input_image",
        image_url: image.url,
        detail: image.detail ?? getString(item.detail) ?? "auto"
      };
    }
    return undefined;
  }

  if (type === "input_audio" || type === "audio_url") {
    const audio = normalizeAudioValue(item.input_audio ?? item.audio_url ?? item.audio);
    if (audio) {
      return {
        type: "input_audio",
        input_audio: audio
      };
    }
    return undefined;
  }

  if (type === "input_file" || type === "file") {
    const file = normalizeFileValue(item.input_file ?? item.file ?? item);
    if (file) {
      return {
        type: "input_file",
        ...file
      };
    }
    return undefined;
  }

  return {
    type: "input_text",
    text: stringifyFallback(item)
  };
}

function parseInputContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }

  const parts = getArray(content);
  if (parts.length === 0) {
    return [{ type: "input_text", text: stringifyFallback(content) }];
  }

  const items = parts
    .map((part) => parseInputContentPart(part))
    .filter((part): part is Record<string, unknown> => Boolean(part));

  return items.length > 0 ? items : [{ type: "input_text", text: stringifyFallback(content) }];
}

function parseAssistantOutputContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "output_text", text: content }];
  }

  const parts = getArray(content);
  const items: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    const item = toObject(part);
    if (!item) {
      continue;
    }

    const type = getString(item.type);
    if (type === "text" || type === "output_text") {
      items.push({
        type: "output_text",
        text: getString(item.text) ?? ""
      });
      continue;
    }

    if (type === "refusal") {
      items.push({
        type: "refusal",
        refusal: getString(item.refusal) ?? ""
      });
    }
  }

  return items;
}

function toToolCallObject(tool: unknown, fallbackIndex: number): Record<string, unknown> | undefined {
  const item = toObject(tool);
  if (!item) {
    return undefined;
  }

  const functionDef = toObject(item.function);
  const name = getString(functionDef?.name);
  if (!name) {
    return undefined;
  }

  const callId = getString(item.id) ?? createSyntheticId(`call-${fallbackIndex}`);
  const rawArguments = functionDef?.arguments;
  const argumentsText =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined
        ? "{}"
        : stringifyFallback(rawArguments);

  return {
    type: "function_call",
    id: createSyntheticId("fc"),
    call_id: callId,
    name,
    arguments: argumentsText
  };
}

function toLegacyFunctionCallObject(value: unknown): Record<string, unknown> | undefined {
  const item = toObject(value);
  if (!item) {
    return undefined;
  }

  const name = getString(item.name);
  if (!name) {
    return undefined;
  }

  const rawArguments = item.arguments;
  return {
    type: "function_call",
    id: createSyntheticId("fc"),
    call_id: createSyntheticId("call"),
    name,
    arguments:
      typeof rawArguments === "string"
        ? rawArguments
        : rawArguments === undefined
          ? "{}"
          : stringifyFallback(rawArguments)
  };
}

function parseToolResultOutput(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content;
  }

  const parts = parseInputContent(content);
  if (parts.length === 1 && parts[0]?.type === "input_text") {
    return getString(parts[0].text) ?? "";
  }

  return parts;
}

function buildCodexInputFromChatMessages(messages: unknown[]): {
  instructions?: string;
  input: Array<Record<string, unknown>>;
} {
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];
  let toolCallIndex = 0;

  for (const raw of messages) {
    const message = toObject(raw);
    if (!message) {
      continue;
    }

    const role = getString(message.role);
    if (!role) {
      continue;
    }

    if (role === "system" || role === "developer") {
      instructions.push(parseAssistantContentText(message.content));
      continue;
    }

    if (role === "user") {
      input.push({
        role: "user",
        content: parseInputContent(message.content)
      });
      continue;
    }

    if (role === "assistant") {
      const assistantContent = parseAssistantOutputContent(message.content);
      if (assistantContent.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          status: "completed",
          id: createSyntheticId("msg"),
          content: assistantContent
        });
      }

      const toolCalls = getArray(message.tool_calls)
        .map((tool) => {
          toolCallIndex += 1;
          return toToolCallObject(tool, toolCallIndex);
        })
        .filter((tool): tool is Record<string, unknown> => Boolean(tool));
      if (toolCalls.length > 0) {
        input.push(...toolCalls);
      }

      const legacyFunctionCall = toLegacyFunctionCallObject(message.function_call);
      if (legacyFunctionCall) {
        input.push(legacyFunctionCall);
      }
      continue;
    }

    if (role === "tool" || role === "function") {
      input.push({
        type: "function_call_output",
        call_id: getString(message.tool_call_id) ?? getString(message.name) ?? createSyntheticId("call"),
        output: parseToolResultOutput(message.content)
      });
    }
  }

  return {
    instructions: instructions.filter(Boolean).join("\n\n") || undefined,
    input
  };
}

function convertToolDefinition(tool: unknown): Record<string, unknown> | undefined {
  const item = toObject(tool);
  if (!item || getString(item.type) !== "function") {
    return undefined;
  }

  const fn = toObject(item.function);
  const name = getString(fn?.name);
  if (!name) {
    return undefined;
  }

  const converted: Record<string, unknown> = {
    type: "function",
    name,
    parameters: toObject(fn?.parameters) ?? fn?.parameters ?? {}
  };

  const description = getString(fn?.description);
  if (description) {
    converted.description = description;
  }

  const strict = getBoolean(fn?.strict ?? item.strict);
  if (strict !== undefined) {
    converted.strict = strict;
  }

  return converted;
}

function convertToolChoice(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }

  const item = toObject(value);
  if (!item) {
    return undefined;
  }

  if (getString(item.type) === "function") {
    const fn = toObject(item.function);
    const name = getString(fn?.name);
    if (name) {
      return {
        type: "function",
        name
      };
    }
  }

  if (getString(item.type) === "tool" && typeof item.name === "string") {
    return {
      type: "function",
      name: item.name
    };
  }

  return value;
}

function buildCodexRequestFromChatCompletion(
  payload: OpenAIChatCompletionRequest,
  options: CodexRequestOptions = {}
): Record<string, unknown> {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const { instructions, input } = buildCodexInputFromChatMessages(messages);
  const body: Record<string, unknown> = {
    model: payload.model,
    store: false,
    stream: payload.stream === true,
    input
  };

  if (instructions) {
    body.instructions = instructions;
  }

  if (typeof payload.max_tokens === "number") {
    body.max_output_tokens = payload.max_tokens;
  } else if (typeof payload.max_completion_tokens === "number") {
    body.max_output_tokens = payload.max_completion_tokens;
  }

  if (typeof payload.temperature === "number") {
    body.temperature = payload.temperature;
  }
  if (typeof payload.top_p === "number") {
    body.top_p = payload.top_p;
  }
  if (typeof payload.user === "string") {
    body.metadata = { user: payload.user };
  }
  if (typeof payload.store === "boolean") {
    body.store = payload.store;
  }
  if (payload.metadata && typeof payload.metadata === "object") {
    body.metadata = {
      ...(toObject(body.metadata) ?? {}),
      ...payload.metadata as Record<string, unknown>
    };
  }

  const tools = getArray(payload.tools)
    .map((tool) => convertToolDefinition(tool))
    .filter((tool): tool is Record<string, unknown> => Boolean(tool));
  if (tools.length > 0) {
    body.tools = tools;
  }

  const toolChoice = convertToolChoice(payload.tool_choice);
  if (toolChoice !== undefined) {
    body.tool_choice = toolChoice;
  }

  if (typeof payload.parallel_tool_calls === "boolean") {
    body.parallel_tool_calls = payload.parallel_tool_calls;
  }

  if (Array.isArray(payload.modalities) && payload.modalities.length > 0) {
    body.modalities = payload.modalities;
  }

  if (payload.audio && typeof payload.audio === "object") {
    body.audio = payload.audio;
  }

  if (payload.reasoning && typeof payload.reasoning === "object") {
    body.reasoning = payload.reasoning;
  }

  if (payload.response_format && typeof payload.response_format === "object") {
    body.text = {
      ...(toObject(body.text) ?? {}),
      format: payload.response_format
    };
  }

  const promptCacheKey =
    getString(payload.prompt_cache_key) ??
    getString(toObject(payload.metadata)?.prompt_cache_key) ??
    options.promptCacheKey ??
    options.sessionId;
  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
  }

  return body;
}

function buildCodexRequestFromResponses(
  payload: Record<string, unknown>,
  options: CodexRequestOptions = {}
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...payload,
    store: payload.store === true ? true : false
  };
  const promptCacheKey =
    getString(payload.prompt_cache_key) ??
    getString(toObject(payload.metadata)?.prompt_cache_key) ??
    options.promptCacheKey ??
    options.sessionId;
  if (promptCacheKey && typeof body.prompt_cache_key !== "string") {
    body.prompt_cache_key = promptCacheKey;
  }
  return body;
}

function mapFinishReason(status: string | undefined, hasToolCalls: boolean): "stop" | "length" | "tool_calls" {
  if (hasToolCalls) {
    return "tool_calls";
  }
  if (status === "incomplete") {
    return "length";
  }
  return "stop";
}

function normalizeToolCallArguments(argumentsText: string): string {
  return argumentsText.length > 0 ? argumentsText : "{}";
}

function createChatCompletionChunk(
  aggregate: ChatCompletionAggregate,
  delta: Record<string, unknown>,
  finishReason: string | null
): string {
  return JSON.stringify({
    id: aggregate.id,
    object: "chat.completion.chunk",
    created: aggregate.created,
    model: aggregate.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  });
}

function createChatCompletionResponse(aggregate: ChatCompletionAggregate): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: aggregate.content.length > 0 ? aggregate.content : null
  };

  if (aggregate.toolCalls.length > 0) {
    message.tool_calls = aggregate.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: normalizeToolCallArguments(toolCall.arguments)
      }
    }));
  }

  if (aggregate.refusal) {
    message.refusal = aggregate.refusal;
  }

  return {
    id: aggregate.id,
    object: "chat.completion",
    created: aggregate.created,
    model: aggregate.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: aggregate.finishReason
      }
    ],
    usage: aggregate.usage
  };
}

async function* parseSSE(response: Response): AsyncGenerator<CodexEvent> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
          .trim();

        if (data && data !== "[DONE]") {
          yield JSON.parse(data) as CodexEvent;
        }

        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best-effort */
    }
  }
}

async function readCodexError(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "application/json; charset=utf-8";
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: {
      "content-type": contentType
    }
  });
}

function getEventText(event: CodexEvent): string {
  const delta = getString(event.delta);
  if (delta) {
    return delta;
  }

  const item = toObject(event.item);
  if (!item) {
    return "";
  }

  const content = getArray(item.content);
  return content
    .map((part) => {
      const obj = toObject(part);
      if (!obj) {
        return "";
      }
      if (getString(obj.type) === "output_text") {
        return getString(obj.text) ?? "";
      }
      if (getString(obj.type) === "refusal") {
        return getString(obj.refusal) ?? "";
      }
      return "";
    })
    .join("");
}

function getResponseUsage(response: Record<string, unknown> | undefined):
  | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  | undefined {
  const usage = toObject(response?.usage);
  if (!usage) {
    return undefined;
  }

  return {
    prompt_tokens: getNumber(usage.input_tokens) ?? 0,
    completion_tokens: getNumber(usage.output_tokens) ?? 0,
    total_tokens: getNumber(usage.total_tokens) ?? 0
  };
}

function ensureToolCall(
  aggregate: ChatCompletionAggregate,
  item: Record<string, unknown>
): ChatCompletionToolCallAggregate {
  const callId = getString(item.call_id) ?? createSyntheticId("call");
  const existing = aggregate.toolCalls.find((toolCall) => toolCall.id === callId);
  if (existing) {
    const name = getString(item.name);
    if (name) {
      existing.name = name;
    }
    return existing;
  }

  const toolCall: ChatCompletionToolCallAggregate = {
    index: aggregate.toolCalls.length,
    id: callId,
    name: getString(item.name) ?? "function",
    arguments: typeof item.arguments === "string" ? item.arguments : ""
  };
  aggregate.toolCalls.push(toolCall);
  return toolCall;
}

function appendTextDelta(aggregate: ChatCompletionAggregate, text: string, refusal = false): void {
  if (!text) {
    return;
  }

  if (refusal) {
    aggregate.refusal = (aggregate.refusal ?? "") + text;
    return;
  }

  aggregate.content += text;
}

function applyOutputItemDone(aggregate: ChatCompletionAggregate, item: Record<string, unknown>): void {
  const type = getString(item.type);
  if (type === "message") {
    const content = getArray(item.content);
    for (const part of content) {
      const block = toObject(part);
      if (!block) {
        continue;
      }
      if (getString(block.type) === "output_text") {
        const text = getString(block.text) ?? "";
        if (!aggregate.content.endsWith(text)) {
          aggregate.content += text;
        }
      } else if (getString(block.type) === "refusal") {
        const refusal = getString(block.refusal) ?? "";
        aggregate.refusal = refusal;
      }
    }
    return;
  }

  if (type === "function_call") {
    const toolCall = ensureToolCall(aggregate, item);
    toolCall.arguments = typeof item.arguments === "string"
      ? item.arguments
      : toolCall.arguments;
  }
}

export class OpenAICodexProvider {
  public async createChatCompletion(
    upstream: UpstreamConfig,
    payload: OpenAIChatCompletionRequest,
    options: CodexRequestOptions = {}
  ): Promise<Response> {
    const requestBody = buildCodexRequestFromChatCompletion(payload, options);
    requestBody.stream = true;

    const response = await fetch(resolveCodexResponsesUrl(upstream.baseUrl), {
      method: "POST",
      headers: buildCodexHeaders(upstream, {
        "content-type": "application/json",
        "openai-beta": "responses=experimental"
      }, {
        accept: "text/event-stream",
        sessionId: options.sessionId
      }),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });

    if (!response.ok) {
      return readCodexError(response);
    }

    const aggregate: ChatCompletionAggregate = {
      id: createSyntheticId("chatcmpl"),
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      content: "",
      finishReason: "stop",
      toolCalls: []
    };

    if (payload.stream) {
      let sentRole = false;
      const stream = new ReadableStream<Uint8Array>({
        start: async (controller) => {
          const encoder = new TextEncoder();

          const sendRoleIfNeeded = () => {
            if (!sentRole) {
              controller.enqueue(encoder.encode(`data: ${createChatCompletionChunk(aggregate, { role: "assistant" }, null)}\n\n`));
              sentRole = true;
            }
          };

          try {
            for await (const event of parseSSE(response)) {
              if (event.type === "response.created") {
                const created = toObject(event.response);
                aggregate.id = getString(created?.id) ?? aggregate.id;
                continue;
              }

              if (event.type === "response.output_text.delta") {
                const text = getEventText(event);
                if (!text) {
                  continue;
                }
                sendRoleIfNeeded();
                appendTextDelta(aggregate, text, false);
                controller.enqueue(encoder.encode(`data: ${createChatCompletionChunk(aggregate, { content: text }, null)}\n\n`));
                continue;
              }

              if (event.type === "response.refusal.delta") {
                const text = getEventText(event);
                if (!text) {
                  continue;
                }
                sendRoleIfNeeded();
                appendTextDelta(aggregate, text, true);
                controller.enqueue(encoder.encode(`data: ${createChatCompletionChunk(aggregate, { refusal: text }, null)}\n\n`));
                continue;
              }

              if (event.type === "response.output_item.added") {
                const item = toObject(event.item);
                if (!item || getString(item.type) !== "function_call") {
                  continue;
                }

                const toolCall = ensureToolCall(aggregate, item);
                sendRoleIfNeeded();
                controller.enqueue(encoder.encode(`data: ${createChatCompletionChunk(aggregate, {
                  tool_calls: [
                    {
                      index: toolCall.index,
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.name,
                        arguments: ""
                      }
                    }
                  ]
                }, null)}\n\n`));
                continue;
              }

              if (event.type === "response.function_call_arguments.delta") {
                const item = toObject(event.item);
                if (!item) {
                  continue;
                }

                const delta = getString(event.delta) ?? "";
                const toolCall = ensureToolCall(aggregate, item);
                toolCall.arguments += delta;
                sendRoleIfNeeded();
                controller.enqueue(encoder.encode(`data: ${createChatCompletionChunk(aggregate, {
                  tool_calls: [
                    {
                      index: toolCall.index,
                      function: {
                        arguments: delta
                      }
                    }
                  ]
                }, null)}\n\n`));
                continue;
              }

              if (event.type === "response.function_call_arguments.done") {
                const item = toObject(event.item);
                if (!item) {
                  continue;
                }

                const toolCall = ensureToolCall(aggregate, item);
                toolCall.arguments = getString(event.arguments) ?? toolCall.arguments;
                continue;
              }

              if (event.type === "response.output_item.done") {
                const item = toObject(event.item);
                if (item) {
                  applyOutputItemDone(aggregate, item);
                }
                continue;
              }

              if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") {
                const completed = toObject(event.response);
                aggregate.id = getString(completed?.id) ?? aggregate.id;
                aggregate.usage = getResponseUsage(completed);
                aggregate.finishReason = mapFinishReason(getString(completed?.status), aggregate.toolCalls.length > 0);
                controller.enqueue(encoder.encode(`data: ${createChatCompletionChunk(aggregate, {}, aggregate.finishReason)}\n\n`));
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }

              if (event.type === "response.failed" || event.type === "error") {
                throw new GatewayError(502, getString(event.message) ?? "Codex response failed");
              }
            }

            controller.enqueue(encoder.encode(`data: ${createChatCompletionChunk(aggregate, {}, aggregate.finishReason)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        }
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache"
        }
      });
    }

    for await (const event of parseSSE(response)) {
      if (event.type === "response.created") {
        const created = toObject(event.response);
        aggregate.id = getString(created?.id) ?? aggregate.id;
        continue;
      }

      if (event.type === "response.output_text.delta") {
        appendTextDelta(aggregate, getEventText(event), false);
        continue;
      }

      if (event.type === "response.refusal.delta") {
        appendTextDelta(aggregate, getEventText(event), true);
        continue;
      }

      if (event.type === "response.output_item.added") {
        const item = toObject(event.item);
        if (item && getString(item.type) === "function_call") {
          ensureToolCall(aggregate, item);
        }
        continue;
      }

      if (event.type === "response.function_call_arguments.delta") {
        const item = toObject(event.item);
        if (item) {
          const toolCall = ensureToolCall(aggregate, item);
          toolCall.arguments += getString(event.delta) ?? "";
        }
        continue;
      }

      if (event.type === "response.function_call_arguments.done") {
        const item = toObject(event.item);
        if (item) {
          const toolCall = ensureToolCall(aggregate, item);
          toolCall.arguments = getString(event.arguments) ?? toolCall.arguments;
        }
        continue;
      }

      if (event.type === "response.output_item.done") {
        const item = toObject(event.item);
        if (item) {
          applyOutputItemDone(aggregate, item);
        }
        continue;
      }

      if (event.type === "response.completed" || event.type === "response.done" || event.type === "response.incomplete") {
        const completed = toObject(event.response);
        aggregate.id = getString(completed?.id) ?? aggregate.id;
        aggregate.usage = getResponseUsage(completed);
        aggregate.finishReason = mapFinishReason(getString(completed?.status), aggregate.toolCalls.length > 0);
      }

      if (event.type === "response.failed" || event.type === "error") {
        throw new GatewayError(502, getString(event.message) ?? "Codex response failed");
      }
    }

    return new Response(JSON.stringify(createChatCompletionResponse(aggregate)), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8"
      }
    });
  }

  public async createResponse(
    upstream: UpstreamConfig,
    payload: Record<string, unknown>,
    options: CodexRequestOptions = {}
  ): Promise<Response> {
    const response = await fetch(resolveCodexResponsesUrl(upstream.baseUrl), {
      method: "POST",
      headers: buildCodexHeaders(upstream, {
        "content-type": "application/json",
        "openai-beta": "responses=experimental"
      }, {
        accept: payload.stream === true ? "text/event-stream" : "application/json",
        sessionId: options.sessionId
      }),
      body: JSON.stringify(buildCodexRequestFromResponses(payload, options)),
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });

    if (!response.ok) {
      return readCodexError(response);
    }

    return response;
  }

  public async proxy(
    upstream: UpstreamConfig,
    method: string,
    path: string,
    body?: string
  ): Promise<Response> {
    const response = await fetch(resolveCodexProxyUrl(upstream.baseUrl, path), {
      method,
      headers: buildCodexHeaders(upstream, body ? { "content-type": "application/json" } : {}),
      body: method !== "GET" && method !== "HEAD" ? body : undefined,
      signal: AbortSignal.timeout(upstream.timeoutMs ?? 120_000)
    });

    if (!response.ok) {
      return readCodexError(response);
    }

    return response;
  }
}
