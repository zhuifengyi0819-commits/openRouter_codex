import type { OpenAIChatCompletionRequest } from "../types/api.js";
import { GatewayError } from "../core/http-error.js";

type JsonObject = Record<string, unknown>;

const INTERNAL_REQUEST_KEYS = new Set(["session_id", "prompt_cache_key"]);
const INTERNAL_METADATA_KEYS = new Set(["session_id", "prompt_cache_key"]);

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function ensureObject(body: unknown): JsonObject {
  if (!isPlainObject(body)) {
    throw new GatewayError(400, "Request body must be a JSON object");
  }
  return body;
}

function requireModel(payload: JsonObject): string {
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!model) {
    throw new GatewayError(400, "`model` is required");
  }
  return model;
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripUndefined(item))
      .filter((item) => item !== undefined);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const cleaned = stripUndefined(entry);
    if (cleaned !== undefined) {
      result[key] = cleaned;
    }
  }
  return result;
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

function normalizeResponseFormat(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "json_object") {
      return { type: "json_object" };
    }
    if (value === "json_schema") {
      return { type: "json_schema" };
    }
    return value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  if (!value.type && isPlainObject(value.json_schema)) {
    return {
      ...value,
      type: "json_schema"
    };
  }

  return value;
}

function normalizeToolChoice(value: unknown): unknown {
  if (typeof value === "string") {
    return value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const name =
    typeof value.name === "string"
      ? value.name
      : typeof (value.function as JsonObject | undefined)?.name === "string"
        ? (value.function as JsonObject).name as string
        : undefined;
  if (!name) {
    return value;
  }

  return {
    type: "function",
    function: {
      name
    }
  };
}

function normalizeLegacyFunctions(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tools = value
    .map((entry) => {
      if (!isPlainObject(entry) || typeof entry.name !== "string") {
        return undefined;
      }

      const tool: JsonObject = {
        type: "function",
        function: {
          name: entry.name
        }
      };

      const fn = tool.function as JsonObject;
      if (typeof entry.description === "string") {
        fn.description = entry.description;
      }
      if (entry.parameters !== undefined) {
        fn.parameters = entry.parameters;
      }
      if (typeof entry.strict === "boolean") {
        fn.strict = entry.strict;
      }

      return tool;
    })
    .filter((entry): entry is JsonObject => Boolean(entry));

  return tools.length > 0 ? tools : undefined;
}

function normalizeToolCall(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  const normalized: JsonObject = { ...value };
  if (normalized.type === undefined && isPlainObject(normalized.function)) {
    normalized.type = "function";
  }

  const fn = isPlainObject(normalized.function) ? { ...normalized.function } : undefined;
  if (fn && fn.arguments !== undefined && typeof fn.arguments !== "string") {
    fn.arguments = stringifyFallback(fn.arguments);
  }
  if (fn) {
    normalized.function = fn;
  }

  return normalized;
}

function normalizeChatContentPart(part: unknown): unknown {
  if (!isPlainObject(part)) {
    return part;
  }

  const normalized: JsonObject = { ...part };
  if (normalized.type === "input_text") {
    normalized.type = "text";
  }

  if (normalized.type === "input_image") {
    const imageUrl = normalized.image_url ?? normalized.url;
    normalized.type = "image_url";
    normalized.image_url = isPlainObject(imageUrl)
      ? imageUrl
      : typeof imageUrl === "string"
        ? { url: imageUrl }
        : undefined;
    delete normalized.url;
  }

  if (normalized.type === "image_url" && typeof normalized.image_url === "string") {
    normalized.image_url = { url: normalized.image_url };
  }

  return stripUndefined(normalized);
}

function contentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return stringifyFallback(value);
  }

  return value
    .map((entry) => {
      if (!isPlainObject(entry)) {
        return typeof entry === "string" ? entry : "";
      }

      if (typeof entry.text === "string") {
        return entry.text;
      }
      if (typeof entry.refusal === "string") {
        return entry.refusal;
      }
      return "";
    })
    .join("");
}

function normalizeChatMessage(message: unknown): unknown {
  if (!isPlainObject(message)) {
    return message;
  }

  const normalized: JsonObject = { ...message };
  const role = typeof normalized.role === "string" ? normalized.role : undefined;
  if (normalized.content !== undefined) {
    if (role === "tool" || role === "function") {
      normalized.content = contentToText(normalized.content);
    } else if (Array.isArray(normalized.content)) {
      normalized.content = normalized.content
        .map((entry) => normalizeChatContentPart(entry))
        .filter((entry) => entry !== undefined);
    }
  }

  if (Array.isArray(normalized.tool_calls)) {
    normalized.tool_calls = normalized.tool_calls.map((entry) => normalizeToolCall(entry));
  }

  if (isPlainObject(normalized.function_call) && normalized.function_call.arguments !== undefined) {
    normalized.function_call = {
      ...normalized.function_call,
      arguments:
        typeof normalized.function_call.arguments === "string"
          ? normalized.function_call.arguments
          : stringifyFallback(normalized.function_call.arguments)
    };
  }

  return stripUndefined(normalized);
}

function stripInternalKeys(payload: JsonObject): JsonObject {
  const normalized: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (INTERNAL_REQUEST_KEYS.has(key)) {
      continue;
    }

    if (key === "metadata" && isPlainObject(value)) {
      const metadata: JsonObject = {};
      for (const [metaKey, metaValue] of Object.entries(value)) {
        if (!INTERNAL_METADATA_KEYS.has(metaKey)) {
          metadata[metaKey] = metaValue;
        }
      }
      if (Object.keys(metadata).length > 0) {
        normalized.metadata = metadata;
      }
      continue;
    }

    normalized[key] = value;
  }
  return normalized;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function buildResponsesInputFromMessages(messages: unknown[]): {
  instructions?: string;
  input: Array<Record<string, unknown>>;
} {
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const raw of messages) {
    if (!isPlainObject(raw) || typeof raw.role !== "string") {
      continue;
    }

    if (raw.role === "system" || raw.role === "developer") {
      const text = contentToText(raw.content);
      if (text) {
        instructions.push(text);
      }
      continue;
    }

    if (raw.role === "assistant") {
      input.push({
        role: "assistant",
        content: raw.content
      });
      continue;
    }

    if (raw.role === "user") {
      input.push({
        role: "user",
        content: raw.content
      });
      continue;
    }

    if (raw.role === "tool" || raw.role === "function") {
      input.push({
        type: "function_call_output",
        call_id:
          typeof raw.tool_call_id === "string"
            ? raw.tool_call_id
            : typeof raw.name === "string"
              ? raw.name
              : "tool_call",
        output: contentToText(raw.content)
      });
    }
  }

  return {
    instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined,
    input
  };
}

function normalizeBasePayload(body: unknown): {
  payload: JsonObject;
  publicModel: string;
} {
  const payload = {
    ...ensureObject(body)
  };
  const publicModel = requireModel(payload);
  payload.model = publicModel;
  return {
    payload,
    publicModel
  };
}

export function normalizeOpenAIRequest(body: unknown): {
  payload: OpenAIChatCompletionRequest;
  publicModel: string;
} {
  const { payload, publicModel } = normalizeBasePayload(body);
  if (!Array.isArray(payload.messages)) {
    if (payload.input !== undefined) {
      payload.messages = [{ role: "user", content: payload.input }];
    } else {
      throw new GatewayError(400, "`messages` must be an array");
    }
  }

  const messages = payload.messages as unknown[];
  payload.messages = messages.map((message) => normalizeChatMessage(message));
  return {
    payload: payload as OpenAIChatCompletionRequest,
    publicModel
  };
}

export function normalizeOpenAIResponsesRequest(body: unknown): {
  payload: JsonObject;
  publicModel: string;
} {
  return normalizeBasePayload(body);
}

export function normalizeOpenAIEmbeddingsRequest(body: unknown): {
  payload: JsonObject;
  publicModel: string;
} {
  return normalizeBasePayload(body);
}

export function buildOpenAIChatUpstreamPayload(
  payload: OpenAIChatCompletionRequest,
  resolvedModel: string
): OpenAIChatCompletionRequest {
  const upstreamPayload = stripInternalKeys(stripUndefined({
    ...payload,
    model: resolvedModel
  }) as JsonObject);

  if (!Array.isArray(upstreamPayload.messages) && upstreamPayload.input !== undefined) {
    upstreamPayload.messages = [{ role: "user", content: upstreamPayload.input }];
  }

  if (Array.isArray(upstreamPayload.messages)) {
    upstreamPayload.messages = upstreamPayload.messages.map((message) => normalizeChatMessage(message));
  }

  if (!Array.isArray(upstreamPayload.tools)) {
    const tools = normalizeLegacyFunctions(upstreamPayload.functions);
    if (tools) {
      upstreamPayload.tools = tools;
    }
  }
  delete upstreamPayload.functions;

  if (upstreamPayload.tool_choice === undefined && upstreamPayload.function_call !== undefined) {
    upstreamPayload.tool_choice = normalizeToolChoice(upstreamPayload.function_call);
  } else {
    upstreamPayload.tool_choice = normalizeToolChoice(upstreamPayload.tool_choice);
  }
  delete upstreamPayload.function_call;

  if (upstreamPayload.response_format !== undefined) {
    upstreamPayload.response_format = normalizeResponseFormat(upstreamPayload.response_format);
  }

  const maxCompletionTokens = pickNumber(
    upstreamPayload.max_completion_tokens,
    upstreamPayload.maxCompletionTokens,
    upstreamPayload.max_output_tokens
  );
  if (maxCompletionTokens !== undefined && upstreamPayload.max_completion_tokens === undefined) {
    upstreamPayload.max_completion_tokens = maxCompletionTokens;
  }
  delete upstreamPayload.maxCompletionTokens;
  delete upstreamPayload.max_output_tokens;

  return upstreamPayload as OpenAIChatCompletionRequest;
}

export function buildOpenAIResponsesUpstreamPayload(
  payload: JsonObject,
  resolvedModel: string
): JsonObject {
  const upstreamPayload = stripInternalKeys(stripUndefined({
    ...payload,
    model: resolvedModel
  }) as JsonObject);

  if (upstreamPayload.input === undefined && Array.isArray(upstreamPayload.messages)) {
    const converted = buildResponsesInputFromMessages(upstreamPayload.messages);
    if (converted.input.length > 0) {
      upstreamPayload.input = converted.input;
    }
    if (converted.instructions && upstreamPayload.instructions === undefined) {
      upstreamPayload.instructions = converted.instructions;
    }
  }
  delete upstreamPayload.messages;

  if (!Array.isArray(upstreamPayload.tools)) {
    const tools = normalizeLegacyFunctions(upstreamPayload.functions);
    if (tools) {
      upstreamPayload.tools = tools;
    }
  }
  delete upstreamPayload.functions;

  if (upstreamPayload.tool_choice === undefined && upstreamPayload.function_call !== undefined) {
    upstreamPayload.tool_choice = normalizeToolChoice(upstreamPayload.function_call);
  } else {
    upstreamPayload.tool_choice = normalizeToolChoice(upstreamPayload.tool_choice);
  }
  delete upstreamPayload.function_call;

  const maxOutputTokens = pickNumber(
    upstreamPayload.max_output_tokens,
    upstreamPayload.maxOutputTokens,
    upstreamPayload.max_completion_tokens,
    upstreamPayload.max_tokens
  );
  if (maxOutputTokens !== undefined) {
    upstreamPayload.max_output_tokens = maxOutputTokens;
  }
  delete upstreamPayload.maxOutputTokens;
  delete upstreamPayload.max_completion_tokens;
  delete upstreamPayload.maxCompletionTokens;
  delete upstreamPayload.max_tokens;

  if (upstreamPayload.response_format !== undefined) {
    const text = isPlainObject(upstreamPayload.text) ? { ...upstreamPayload.text } : {};
    if (text.format === undefined) {
      text.format = normalizeResponseFormat(upstreamPayload.response_format);
    }
    upstreamPayload.text = stripUndefined(text);
    delete upstreamPayload.response_format;
  }

  return upstreamPayload;
}

export function buildOpenAIEmbeddingsUpstreamPayload(
  payload: JsonObject,
  resolvedModel: string
): JsonObject {
  const upstreamPayload = stripInternalKeys(stripUndefined({
    ...payload,
    model: resolvedModel
  }) as JsonObject);

  if (upstreamPayload.encoding_format === undefined && typeof upstreamPayload.encodingFormat === "string") {
    upstreamPayload.encoding_format = upstreamPayload.encodingFormat;
  }
  delete upstreamPayload.encodingFormat;

  if (upstreamPayload.dimensions === undefined && typeof upstreamPayload.embedding_dimensions === "number") {
    upstreamPayload.dimensions = upstreamPayload.embedding_dimensions;
  }
  delete upstreamPayload.embedding_dimensions;

  return upstreamPayload;
}
