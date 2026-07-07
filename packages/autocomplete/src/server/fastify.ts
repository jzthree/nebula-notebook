import type { AutocompleteEngine } from "../core/engine.js";
import type { CompletionRequest } from "../types.js";

/**
 * Minimal structural types so this plugin works with Fastify 4/5 without a
 * hard dependency on the fastify package.
 */
interface FastifyLikeRequest {
  body: unknown;
}
interface FastifyLikeReply {
  raw: {
    writeHead(status: number, headers: Record<string, string>): void;
    write(chunk: string): void;
    end(): void;
    on(event: "close", cb: () => void): void;
    writableEnded: boolean;
  };
  hijack?: () => void;
}
interface FastifyLikeInstance {
  post(
    path: string,
    handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<void>,
  ): void;
}

export interface AutocompleteRouteOptions {
  /** Route path. Default "/autocomplete". */
  path?: string;
}

export type EngineResolver = (req: CompletionRequest) => AutocompleteEngine;

/**
 * Register `POST <path>` streaming completions as SSE.
 *
 * Request body: CompletionRequest (JSON).
 * Response events: {type:"chunk",text} then {type:"done",...CompletionResult},
 * or {type:"error",message}.
 *
 * Usage in nebula-notebook's node-server:
 *   const engine = new AutocompleteEngine({ backend: new ClaudeBackend() });
 *   app.register(async (f) => registerAutocompleteRoute(f, engine), { prefix: "/api" });
 */
export function registerAutocompleteRoute(
  fastify: FastifyLikeInstance,
  engine: AutocompleteEngine | EngineResolver,
  options: AutocompleteRouteOptions = {},
): void {
  const path = options.path ?? "/autocomplete";
  const resolve: EngineResolver =
    typeof engine === "function" ? engine : () => engine;
  fastify.post(path, async (req, reply) => {
    reply.hijack?.(); // take over the raw socket for SSE (Fastify 4/5)
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const abort = new AbortController();
    // Detect client disconnect via the RESPONSE stream closing before we
    // ended it. (The request's "close" fires as soon as its body is fully
    // consumed on modern Node — listening there aborts every request.)
    res.on("close", () => {
      if (!res.writableEnded) abort.abort(new Error("client disconnected"));
    });

    try {
      const body = req.body as CompletionRequest;
      if (!body || typeof body.prefix !== "string") {
        send({ type: "error", message: "prefix (string) is required" });
        res.end();
        return;
      }
      const result = await resolve(body).complete(body, {
        signal: abort.signal,
        onChunk: (text) => send({ type: "chunk", text }),
      });
      send({ type: "done", ...result });
    } catch (e) {
      if (!abort.signal.aborted) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
    res.end();
  });
}
