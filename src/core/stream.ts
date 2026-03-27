import { Readable } from "node:stream";

import type { FastifyReply } from "fastify";
import { getRequestTraceId, logResponseSnapshot } from "./request-logs.js";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length"
]);

export function relayResponse(
  reply: FastifyReply,
  upstreamResponse: Response,
  extraHeaders: Record<string, string> = {}
): FastifyReply | Promise<FastifyReply> {
  const traceId = getRequestTraceId(reply.request.headers as Record<string, unknown>);
  reply.code(upstreamResponse.status);

  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      reply.header(key, value);
    }
  }

  for (const [key, value] of Object.entries(extraHeaders)) {
    reply.header(key, value);
  }

  logResponseSnapshot(traceId, "gateway.response", upstreamResponse, {
    source: "upstream_relay",
    extraHeaders
  });

  if (!upstreamResponse.body) {
    return reply.send();
  }

  const stream = Readable.fromWeb(upstreamResponse.body as any);
  stream.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") {
      return;
    }
    console.log(`[stream] relay error: ${err.message}`);
  });
  return reply.send(stream);
}
