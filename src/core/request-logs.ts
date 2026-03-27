import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const REQUEST_TRACE_HEADER = "x-gateway-request-id";
const MAX_STRING_LENGTH = 16_000;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
let requestLoggingEnabled = false;

function shouldRedactKey(key: string): boolean {
  return /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie)/i.test(key);
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}... [truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function sanitizeValue(value: unknown, keyHint?: string, depth = 0): unknown {
  if (keyHint && shouldRedactKey(keyHint)) {
    return "[redacted]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeValue(entry, undefined, depth + 1));
  }

  if (depth > 8) {
    return "[max-depth]";
  }

  if (value instanceof Headers) {
    return sanitizeHeaders(value);
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
      result[key] = sanitizeValue(entry, key, depth + 1);
    }
    return result;
  }

  return String(value);
}

export function sanitizeHeaders(headers: Headers | IncomingHttpHeaders | Record<string, unknown>): Record<string, unknown> {
  if (headers instanceof Headers) {
    const result: Record<string, unknown> = {};
    headers.forEach((value, key) => {
      result[key] = sanitizeValue(value, key);
    });
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value)
      ? value.map((entry) => sanitizeValue(entry, key))
      : sanitizeValue(value, key);
  }
  return result;
}

async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
}

export function configureRequestLogging(enabled: boolean): void {
  requestLoggingEnabled = enabled;
}

export function isRequestLoggingEnabled(): boolean {
  return requestLoggingEnabled;
}

function getLogFilePath(traceId: string): string {
  return path.join(LOG_DIR, `${traceId}.jsonl`);
}

export function createRequestTraceId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

export function getRequestTraceId(headers: IncomingHttpHeaders | Record<string, unknown>): string | undefined {
  const value = headers[REQUEST_TRACE_HEADER];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function ensureRequestTraceId(headers: Record<string, unknown>): string {
  const existing = getRequestTraceId(headers);
  if (existing) {
    return existing;
  }

  const traceId = createRequestTraceId();
  headers[REQUEST_TRACE_HEADER] = traceId;
  return traceId;
}

export async function appendTraceEvent(traceId: string | undefined, event: Record<string, unknown>): Promise<void> {
  if (!requestLoggingEnabled || !traceId) {
    return;
  }

  await ensureLogDir();
  const sanitizedEvent = sanitizeValue(event) as Record<string, unknown>;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...sanitizedEvent
  }) + "\n";
  await appendFile(getLogFilePath(traceId), line, "utf8");
}

async function readBodySnapshot(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    const text = truncateString(await response.text());
    if (contentType.includes("application/json")) {
      try {
        return sanitizeValue(JSON.parse(text));
      } catch {
        return text;
      }
    }
    return text;
  } catch (error) {
    return `[failed to read body: ${(error as Error).message}]`;
  }
}

export function logResponseSnapshot(
  traceId: string | undefined,
  stage: string,
  response: Response,
  extra: Record<string, unknown> = {}
): void {
  void (async () => {
    const snapshot = response.clone();
    await appendTraceEvent(traceId, {
      stage,
      status: snapshot.status,
      headers: sanitizeHeaders(snapshot.headers),
      body: await readBodySnapshot(snapshot),
      ...extra
    });
  })();
}

export { LOG_DIR, REQUEST_TRACE_HEADER, sanitizeValue };
