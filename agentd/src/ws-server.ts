import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { NotAttachedError } from "./attach-registry";
import { gateFrame, linkTrustFrame, type PhoneChannel, type PhoneV2Hooks } from "./protocol-v2";
import { digestMatchesSecret, secretDigest, secretMatches, watchFiles } from "./tls";
import { SessionStore } from "./session-store";
import type {
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRequest,
} from "./approval-manager";
import type { TerminalInputOutcome } from "./terminal-input";
import { DETAIL_MESSAGE_LIMIT } from "./transcript-messages";
import type { AgentConfig, Logger, Session, SessionMessage } from "./types";

const PROTOCOL_VERSION = 1;
const SERVER_VERSION = (() => {
  const packageJson = JSON.parse(
    readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("nexus-agentd package version is missing");
  }
  return packageJson.version;
})();

/** The first byte of a TLS record carrying a handshake. */
const TLS_HANDSHAKE_BYTE = 0x16;

function refuseHttp(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(426, { "content-type": "text/plain" });
  response.end("WebSocket only\n");
}

interface ClientState {
  authenticated: boolean;
  /**
   * Digest of the steering secret this TLS client presented at hello and that
   * matched then; undefined for a monitor and once revoked. Trust is this digest still matching
   * the current secret (`isTrusted`), so a rotation cuts the client off.
   */
  steerDigest?: Buffer;
  /** The connection is TLS; trust needs this and the secret. */
  encrypted: boolean;
  channel: PhoneChannel;
  lastPongAt: number;
  helloTimer: NodeJS.Timeout;
  pongTimer?: NodeJS.Timeout;
  /** Session whose conversation this client is currently reading, if any. */
  openSessionId?: string;
  /** The last session_upsert payload sent to this client, by session id, so an identical one is not sent again. */
  lastUpserts: Map<string, string>;
}

export interface WsHubOptions {
  host?: string;
  helloTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Supplies the recent conversation of a session for the detail view. */
  detailProvider?: (sessionId: string, limit: number) => Promise<SessionMessage[]>;
  /** Called when a client starts reading a session, so tailing can begin. */
  onDetailOpen?: (sessionId: string) => void;
  /** Called when a phone answers a held tool call over this transport. */
  onApprovalDecision?: (requestId: string, decision: ApprovalDecision) => void;
  /** Types the wearer's text into the session's terminal; see terminal-input. */
  onTerminalInput?: (sessionId: string, text: string) => Promise<TerminalInputOutcome>;
  /**
   * agentd's TLS identity. With it the one port serves both wss and plain ws:
   * the first byte of a connection says which. Plain ws is monitor-only.
   */
  tls?: { key: string; cert: string };
  /**
   * The steering secret, read at each hello so a rotation takes effect at once.
   * A wss client is trusted only if its hello carries it. It is never sent: the
   * token alone, which any plaintext link can see, lets a client in as a monitor.
   */
  steer?: () => string | undefined;
  /** The file behind `steer`, watched so a rotation drops the phones that held the old secret. */
  steerFile?: string;
  /** How often live clients are re-checked against the current secret (the file watch also triggers it). */
  trustCheckIntervalMs?: number;
  v2?: PhoneV2Hooks;
  /** A client finished its handshake, after it has its snapshot. `trusted` is whether it may steer. */
  onClientConnected?: (trusted: boolean) => void;
  /** An authenticated client went away. */
  onClientDisconnected?: () => void;
  /** A client lost its trust (the secret was rotated); it is being dropped. */
  onTrustRevoked?: () => void;
}


function tokenMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string") {
    return false;
  }
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class WsHub {
  private server?: net.Server;
  private plainServer?: http.Server;
  private secureServer?: https.Server;
  private sockets?: WebSocketServer;
  private keepaliveTimer?: NodeJS.Timeout;
  private stopTrustWatch?: () => void;
  private readonly clients = new Map<WebSocket, ClientState>();
  private sequence = 0;
  private readonly unsubscribeUpsert: () => void;
  private readonly unsubscribeRemoved: () => void;

  constructor(
    private readonly config: AgentConfig,
    private readonly store: SessionStore,
    private readonly logger: Logger,
    private readonly options: WsHubOptions = {},
  ) {
    this.unsubscribeUpsert = store.onUpsert((session) => this.broadcastUpsert(session));
    this.unsubscribeRemoved = store.onRemoved((sessionId) => this.broadcastRemoved(sessionId));
  }

  get seq(): number {
    return this.sequence;
  }

  start(): Promise<void> {
    if (this.server) {
      return Promise.resolve();
    }
    // The HTTP servers never listen: the front server below hands each
    // connection to one of them, which only exists to run the upgrade.
    const sockets = new WebSocketServer({ noServer: true });
    const onUpgrade = (request: IncomingMessage, socket: net.Socket, head: Buffer): void => {
      sockets.handleUpgrade(request, socket, head, (client) => this.accept(client, request));
    };
    const plain = http.createServer(refuseHttp);
    plain.on("upgrade", onUpgrade);
    const secure = this.options.tls
      ? https.createServer({ ...this.options.tls, minVersion: "TLSv1.2" }, refuseHttp)
      : undefined;
    secure?.on("upgrade", onUpgrade);
    secure?.on("tlsClientError", (error) => {
      this.logger.warn("ws_tls_client_error", { reason: error.name });
    });
    const server = net.createServer((socket) => this.route(socket, plain, secure));
    this.server = server;
    this.plainServer = plain;
    this.secureServer = secure;
    this.sockets = sockets;
    server.on("error", (error) => {
      this.logger.error("ws_server_error", { reason: error.name });
    });

    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const interval = this.options.keepaliveIntervalMs ?? 30_000;
        this.keepaliveTimer = setInterval(() => this.keepalive(), interval);
        this.keepaliveTimer.unref();
        this.stopTrustWatch = watchFiles(
          this.options.steerFile ? [this.options.steerFile] : [],
          this.options.trustCheckIntervalMs ?? 1_000,
          () => this.recheckTrust(),
        );
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.options.host ?? "0.0.0.0", port: this.config.wsPort });
    });
  }

  /** Peeks at the first byte to tell a TLS handshake from an HTTP request. */
  private route(socket: net.Socket, plain: http.Server, secure: https.Server | undefined): void {
    socket.on("error", () => undefined);
    const timer = setTimeout(() => socket.destroy(), this.options.helloTimeoutMs ?? 5000);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
    socket.once("readable", () => {
      clearTimeout(timer);
      const first: Buffer | null = socket.read(1);
      const target = first && first[0] === TLS_HANDSHAKE_BYTE ? secure : plain;
      if (!first || !target) {
        socket.destroy();
        return;
      }
      socket.unshift(first);
      target.emit("connection", socket);
    });
  }

  port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address !== "string" ? (address as AddressInfo).port : undefined;
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    this.stopTrustWatch?.();
    this.stopTrustWatch = undefined;
    for (const [socket, state] of this.clients) {
      clearTimeout(state.helloTimer);
      if (state.pongTimer) {
        clearTimeout(state.pongTimer);
      }
      socket.terminate();
    }
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    this.sockets?.close();
    this.sockets = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const inner of [this.plainServer, this.secureServer]) {
      inner?.close();
      inner?.closeAllConnections();
    }
    this.plainServer = undefined;
    this.secureServer = undefined;
    this.unsubscribeUpsert();
    this.unsubscribeRemoved();
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const encrypted = (request.socket as Partial<TLSSocket>).encrypted === true;
    const helloTimer = setTimeout(() => {
      if (!this.clients.get(socket)?.authenticated) {
        socket.close(4408, "hello timeout");
      }
    }, this.options.helloTimeoutMs ?? 5000);
    helloTimer.unref();
    const hub = this;
    const state: ClientState = {
      authenticated: false,
      encrypted,
      channel: {
        transport: "wshub",
        get trusted() {
          return hub.isTrusted(state);
        },
        send: (frame) => this.send(socket, frame),
      },
      lastPongAt: Date.now(),
      helloTimer,
      lastUpserts: new Map(),
    };
    this.clients.set(socket, state);

    socket.on("message", (data, isBinary) => this.onMessage(socket, data, isBinary));
    socket.on("error", (error) => {
      this.logger.warn("ws_client_error", { reason: error.name });
    });
    socket.on("close", () => {
      const state = this.clients.get(socket);
      if (state) {
        clearTimeout(state.helloTimer);
        if (state.pongTimer) {
          clearTimeout(state.pongTimer);
        }
      }
      this.clients.delete(socket);
      if (state?.authenticated) {
        this.options.onClientDisconnected?.();
      }
    });
  }

  private onMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const state = this.clients.get(socket);
    if (!state) {
      return;
    }
    if (isBinary) {
      if (!state.authenticated) {
        socket.close(4401, "authentication required");
      } else {
        this.logger.info("ws_binary_ignored");
      }
      return;
    }

    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      message = parsed as Record<string, unknown>;
    } catch {
      if (!state.authenticated) {
        socket.close(4401, "authentication required");
      } else {
        this.logger.info("ws_invalid_json_ignored");
      }
      return;
    }

    if (!state.authenticated) {
      if (
        message.type !== "hello" ||
        message.v !== PROTOCOL_VERSION ||
        !tokenMatches(message.token, this.config.token)
      ) {
        // A phone treats 4401 as final and stops reconnecting, so this is the
        // difference between a link that is retrying and one that has given up
        // for good. Worth saying which of the three it was, without echoing the
        // token itself.
        this.logger.warn("ws_auth_rejected", {
          reason: message.type !== "hello"
            ? "not_hello"
            : message.v !== PROTOCOL_VERSION
              ? "version"
              : "token",
        });
        socket.close(4401, "authentication failed");
        return;
      }
      state.authenticated = true;
      state.steerDigest = this.grantsSteering(state, message.steer);
      state.lastPongAt = Date.now();
      clearTimeout(state.helloTimer);
      this.armPongDeadline(socket, state);
      this.send(socket, {
        type: "hello_ack",
        v: PROTOCOL_VERSION,
        // The grant, stated (R126): the phone binds steering from this, never from its own config,
        // so a stale or missing steer reads as monitor-only on both sides.
        steering: this.isTrusted(state),
        server: {
          name: "nexus-agentd",
          version: SERVER_VERSION,
          machineId: this.config.machineId,
          machineName: this.config.machineName,
        },
      });
      this.sendSnapshot(socket);
      this.options.onClientConnected?.(this.isTrusted(state));
      return;
    }

    // One gate for every frame, before any handler, v1 or v2.
    if (!gateFrame(message, state.channel) || this.options.v2?.handle(message, state.channel)) {
      return;
    }
    switch (message.type) {
      case "refresh":
        this.sendSnapshot(socket);
        break;
      case "pong":
        state.lastPongAt = Date.now();
        this.armPongDeadline(socket, state);
        break;
      case "detail_open": {
        const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
        if (!sessionId) {
          break;
        }
        state.openSessionId = sessionId;
        this.options.onDetailOpen?.(sessionId);
        void this.sendDetail(socket, sessionId);
        break;
      }
      case "detail_close":
        state.openSessionId = undefined;
        break;
      case "session_input": {
        void this.answerTerminalInput(socket, message);
        break;
      }
      case "approval_decision": {
        const requestId =
          typeof message.requestId === "string" && message.requestId.length > 0
            ? message.requestId
            : undefined;
        const decision =
          message.decision === "allow" || message.decision === "deny"
            ? message.decision
            : undefined;
        if (requestId && decision) {
          this.options.onApprovalDecision?.(requestId, decision);
        }
        break;
      }
      default:
        this.logger.info("ws_unknown_message", {
          type: typeof message.type === "string" ? message.type.slice(0, 80) : "missing",
        });
        break;
    }
  }

  /**
   * Steering needs TLS and the steering secret together. The secret is checked
   * in constant time and a length mismatch is just a mismatch. A plaintext
   * client that sends one has put it on the wire, so that is logged.
   */
  private grantsSteering(state: ClientState, presented: unknown): Buffer | undefined {
    if (typeof presented !== "string") {
      return undefined;
    }
    if (!state.encrypted) {
      this.logger.warn("ws_steer_over_plaintext");
      return undefined;
    }
    const expected = this.options.steer?.();
    return expected !== undefined && secretMatches(presented, expected)
      ? secretDigest(presented)
      : undefined;
  }

  /** Live: the secret the client proved must still be the current one. */
  private isTrusted(state: ClientState): boolean {
    return (
      state.encrypted &&
      state.steerDigest !== undefined &&
      digestMatchesSecret(state.steerDigest, this.options.steer?.())
    );
  }

  /**
   * Drops clients that proved a secret which has since been rotated away. The
   * socket is destroyed at once: a client that never answers the close frame
   * would otherwise stay listed for ws's 30 s close timeout, and with it what
   * was held for it. Its digest is dropped, so it is revoked, and logged, once.
   */
  private recheckTrust(): void {
    let revoked = false;
    for (const [socket, state] of this.clients) {
      if (state.authenticated && state.steerDigest !== undefined && !this.isTrusted(state)) {
        state.steerDigest = undefined;
        revoked = true;
        this.logger.warn("ws_trust_revoked", { reason: "steer_rotated" });
        // Said before the close, so the phone stops treating the link as steering (R126).
        this.send(socket, linkTrustFrame(false));
        socket.close(4403, "steering secret rotated");
        socket.terminate();
      }
    }
    if (revoked) {
      this.options.onTrustRevoked?.();
    }
  }

  private async sendDetail(socket: WebSocket, sessionId: string): Promise<void> {
    const provider = this.options.detailProvider;
    let messages: SessionMessage[] = [];
    try {
      messages = provider ? await provider(sessionId, DETAIL_MESSAGE_LIMIT) : [];
    } catch (error) {
      if (!(error instanceof NotAttachedError)) {
        throw error;
      }
      const state = this.clients.get(socket);
      if (state?.openSessionId === sessionId) {
        state.openSessionId = undefined;
      }
      this.send(socket, { type: "detail_rejected", sessionId, error: "not_attached" });
      return;
    }
    const state = this.clients.get(socket);
    // The wearer may have left the conversation while the tail was being read.
    if (!state?.authenticated || state.openSessionId !== sessionId) {
      return;
    }
    this.send(socket, {
      type: "detail",
      sessionId,
      session: this.store.get(sessionId) ?? null,
      messages,
    });
  }

  /**
   * True while some phone has authenticated over this transport, which is what
   * makes it usable for holding a tool call. A phone that dialled in here can
   * answer approvals exactly like one the daemon dialled: the plugin speaks the
   * same frames on both, so only the daemon needed teaching.
   */
  get hasAuthenticatedClient(): boolean {
    for (const state of this.clients.values()) {
      if (state.authenticated) {
        return true;
      }
    }
    return false;
  }

  /**
   * True while a pinned-TLS phone is authenticated. Only such a phone can
   * answer, so only its presence may hold a tool call, a question or a Stop.
   */
  get hasTrustedClient(): boolean {
    return this.trustedClientCount > 0;
  }

  get trustedClientCount(): number {
    let count = 0;
    for (const state of this.clients.values()) {
      if (state.authenticated && this.isTrusted(state)) {
        count += 1;
      }
    }
    return count;
  }

  /** The WebSocket half of typed input; both transports share the judgement. */
  private async answerTerminalInput(
    socket: WebSocket,
    message: Record<string, unknown>,
  ): Promise<void> {
    const id =
      typeof message.id === "string" && message.id.length > 0 && message.id.length <= 64
        ? message.id
        : undefined;
    if (!id) {
      return;
    }
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const outcome = this.options.onTerminalInput
      ? await this.options
          .onTerminalInput(sessionId, typeof message.text === "string" ? message.text : "")
          .catch(() => ({ ok: false, error: "Could not send that" }) as TerminalInputOutcome)
      : { ok: false, error: "Typing from the glasses is not available" };
    this.logger.info("ws_session_input", { sessionId: sessionId.slice(0, 16), ok: outcome.ok });
    if (!this.clients.get(socket)?.authenticated) {
      return;
    }
    this.send(socket, {
      type: "session_input_result",
      id,
      ok: outcome.ok,
      error: outcome.ok ? null : outcome.error ?? "Could not send that",
    });
  }

  /** Approvals, alerts and their resolutions go to trusted phones only: a monitor-only phone cannot answer them. */
  sendApprovalRequest(request: ApprovalRequest): boolean {
    return this.broadcastToTrusted({ ...request });
  }

  /** Any other frame for the phones, such as the v2 alert; false when no trusted phone is connected. */
  broadcastFrame(frame: Record<string, unknown>): boolean {
    return this.broadcastToTrusted(frame);
  }

  sendApprovalResolved(requestId: string, outcome: ApprovalOutcome): boolean {
    return this.broadcastToTrusted({
      type: "approval_resolved",
      v: 1,
      requestId,
      outcome,
    });
  }

  /** Delivered is "at least one phone got it", matching the dialled link's contract. */
  private broadcastToTrusted(message: Record<string, unknown>): boolean {
    let delivered = false;
    for (const [socket, state] of this.clients) {
      if (state.authenticated && this.isTrusted(state)) {
        this.send(socket, message);
        delivered = true;
      }
    }
    return delivered;
  }

  /** Streams a newly appended message to whoever is reading that session. */
  broadcastDetailMessage(sessionId: string, message: SessionMessage): void {
    for (const [socket, state] of this.clients) {
      if (state.authenticated && state.openSessionId === sessionId) {
        this.send(socket, { type: "detail_append", sessionId, message });
      }
    }
  }

  private sendSnapshot(socket: WebSocket): void {
    const v2 = this.options.v2;
    const sessions = this.store.list();
    this.clients.get(socket)?.lastUpserts.clear();
    this.send(socket, {
      type: "snapshot",
      ...(v2 ? { v: 2 } : {}),
      seq: this.sequence,
      sessions: v2 ? sessions.map((session) => v2.decorate(session)) : sessions,
    });
  }

  /**
   * Hooks fire in bursts that change nothing a phone shows, so an upsert every
   * client was already sent is skipped. Otherwise it goes to all of them: the
   * phone treats a gap in `seq` as lost frames and asks for a new snapshot.
   */
  private broadcastUpsert(session: Session): void {
    const v2 = this.options.v2;
    const published = v2 ? v2.decorate(session) : session;
    const payload = JSON.stringify(published);
    let changed = false;
    for (const [socket, state] of this.clients) {
      if (state.authenticated && socket.readyState === WebSocket.OPEN && state.lastUpserts.get(session.id) !== payload) {
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    for (const state of this.clients.values()) {
      if (state.authenticated) {
        state.lastUpserts.set(session.id, payload);
      }
    }
    this.sequence += 1;
    this.broadcast({
      type: "session_upsert",
      ...(v2 ? { v: 2 } : {}),
      seq: this.sequence,
      session: published,
    });
  }

  private broadcastRemoved(sessionId: string): void {
    for (const state of this.clients.values()) {
      state.lastUpserts.delete(sessionId);
    }
    this.sequence += 1;
    this.broadcast({
      type: "session_removed",
      seq: this.sequence,
      sessionId,
    });
  }

  private keepalive(): void {
    const now = Date.now();
    const pongTimeout = this.options.pongTimeoutMs ?? 90_000;
    for (const [socket, state] of this.clients) {
      if (!state.authenticated || socket.readyState !== WebSocket.OPEN) {
        continue;
      }
      if (now - state.lastPongAt >= pongTimeout) {
        socket.close(4409, "pong timeout");
        continue;
      }
      this.send(socket, { type: "ping", t: now });
      socket.ping();
    }
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const [socket, state] of this.clients) {
      if (state.authenticated && socket.readyState === WebSocket.OPEN) {
        this.send(socket, message);
      }
    }
  }

  private send(socket: WebSocket, message: Record<string, unknown>): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private armPongDeadline(socket: WebSocket, state: ClientState): void {
    if (state.pongTimer) {
      clearTimeout(state.pongTimer);
    }
    state.pongTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(4409, "pong timeout");
      }
    }, this.options.pongTimeoutMs ?? 90_000);
    state.pongTimer.unref();
  }
}
