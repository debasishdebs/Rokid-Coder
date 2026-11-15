import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HookResponse } from "./approval-manager";
import type { HookPayload, Logger } from "./types";

export interface HookHttpServerOptions {
  port: number;
  sessionCount: () => number;
  /**
   * `closed` aborts (reason "cancelled") when the forwarder goes away before it
   * has its reply, which is how a held hook learns it was killed.
   */
  onHook: (
    payload: HookPayload,
    closed: AbortSignal,
  ) => HookResponse | void | Promise<HookResponse | void>;
  logger: Logger;
  extraHealth?: () => Record<string, unknown>;
}

export class HookHttpServer {
  private server?: Server;
  private ready = false;
  private readonly startedAt = Date.now();

  constructor(private readonly options: HookHttpServerOptions) {}

  /** Binds the port and serves: `bind`, if it has not run, then requests are answered. */
  async start(): Promise<void> {
    await this.bind();
    this.ready = true;
  }

  /**
   * Takes the port without serving yet: agentd holds it from before its first
   * read of the phone pins, as the pin writer lock (R209). Until `start`,
   * every request is refused with 503.
   */
  bind(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }
    const server = createServer((request, response) => {
      if (!this.ready) {
        response.writeHead(503, { "content-type": "application/json", connection: "close" });
        response.end('{"error":"starting"}');
        return;
      }
      if (request.method === "GET" && request.url === "/health") {
        const body = JSON.stringify({
          ok: true,
          sessions: this.options.sessionCount(),
          uptimeMs: Date.now() - this.startedAt,
          ...this.options.extraHealth?.(),
        });
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        response.end(body);
        return;
      }

      if (request.method === "POST" && request.url === "/hook") {
        // Not request "close": that fires after every request ends normally. The
        // response closing before it was ended means the client socket went away.
        const closed = new AbortController();
        response.on("close", () => {
          if (!response.writableEnded) {
            closed.abort("cancelled");
          }
        });
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          let payload: HookPayload;
          try {
            const parsed: unknown = JSON.parse(body);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("payload is not a JSON object");
            }
            payload = parsed as HookPayload;
          } catch (error) {
            this.options.logger.warn("hook_parse_failed", {
              bodyBytes: Buffer.byteLength(body),
              reason: error instanceof Error ? error.name : "unknown",
            });
            this.respond(response, {});
            return;
          }
          // Only the forwarder's header names the provider. Whatever the body
          // claims for itself is dropped, so a payload cannot pick its own.
          delete payload.__provider;
          // Hooks never bind or steer a launcher session (R48): only the
          // launcher socket speaks for a launcher.
          delete payload.launcherId;
          const provider = request.headers["x-rokid-provider"];
          if (provider === "claude" || provider === "codex") {
            payload.__provider = provider;
          }
          // Inside the executor, so a synchronous throw becomes a rejection
          // instead of escaping this handler and taking the daemon down.
          new Promise<HookResponse | void>((resolve) => resolve(this.options.onHook(payload, closed.signal)))
            .then((result) => this.respond(response, result ?? {}))
            .catch((error) => {
              this.options.logger.error("hook_processing_failed", {
                reason: error instanceof Error ? error.name : "unknown",
              });
              this.respond(response, {});
            });
        });
        request.on("error", () => {
          closed.abort("cancelled");
          if (!response.headersSent) {
            this.respond(response, {});
          }
        });
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ port: this.options.port, host: "127.0.0.1", exclusive: true });
    });
  }

  port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address !== "string" ? (address as AddressInfo).port : undefined;
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.ready = false;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      // A hook released by shutdown is answered just after close() looked for
      // idle connections, so its keep-alive socket would hold the server open
      // until the keep-alive timeout.
      setImmediate(() => server.closeIdleConnections());
    });
  }

  private respond(response: import("node:http").ServerResponse, value: HookResponse): void {
    if (response.headersSent || response.destroyed) {
      return;
    }
    const body = JSON.stringify(value);
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}
