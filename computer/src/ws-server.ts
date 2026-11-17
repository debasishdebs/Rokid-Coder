import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { NotAttachedError } from "./attach-registry";
import type { PairingCoordinator, PairingSession } from "./pairing/coordinator";
import { endpointFrame, gateFrame, linkTrustFrame, type PhoneChannel, type PhoneV2Hooks } from "./protocol-v2";
import {
  DAY_MS,
  DEFAULT_PAIRING_TTL_DAYS,
  PinStore,
  digestMatchesSecret,
  fingerprintOfCert,
  normalizeFingerprint,
  secretDigest,
  secretMatches,
  shortFingerprint,
  watchFiles,
} from "./tls";
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

/** The close code after a `hello_reject`, and after a live link loses its trust. */
const CLOSE_UNTRUSTED = 4403;
/** How long a client losing its trust has to take the close frame before its socket is destroyed. */
const REVOKED_CLOSE_GRACE_MS = 500;

/** What OpenSSL says when the first bytes on the port are not a TLS record: a plaintext client. */
const PLAINTEXT_ERRORS = new Set([
  "ERR_SSL_HTTP_REQUEST",
  "ERR_SSL_HTTPS_PROXY_REQUEST",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
]);

/** Why a hello was refused, as the phone is told: re-pair, or the token is wrong. */
type HelloRejectReason = "repair_needed" | "bad_token";

/**
 * A hello's checks: admitted (its cert pinned, or provisional and now proving
 * it stored the credentials), or why not, for the phone and the log.
 */
type Admission =
  | { ok: true; recovery?: string }
  | { ok: false; reason: HelloRejectReason; log: string };

function refuseHttp(_request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(426, { "content-type": "text/plain" });
  response.end("WebSocket only\n");
}

interface ClientState {
  authenticated: boolean;
  /**
   * Digest of the steering secret this client presented at hello; undefined
   * before then and once revoked. Trust is this digest still matching the
   * current secret and the peer cert still being pinned (`isTrusted`), so a
   * rotation or a forget cuts the client off.
   */
  steerDigest?: Buffer;
  /** The SHA-256 of the client cert the phone presented, or undefined when it presented none. */
  peerFingerprint?: string;
  /** Set when this unpinned peer reached an open pairing window: every frame is the SAS session's. */
  sas?: PairingSession;
  channel: PhoneChannel;
  lastPongAt: number;
  helloTimer: NodeJS.Timeout;
  pongTimer?: NodeJS.Timeout;
  /** Session whose conversation this client is currently reading, if any. */
  openSessionId?: string;
  /** The last session_upsert payload sent to this client, by session id, so an identical one is not sent again. */
  lastUpserts: Map<string, string>;
  /** The `endpoint` frame last sent to this client, serialized, so an unchanged list is not sent again. */
  lastEndpoint?: string;
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
   * agentd's TLS identity. Required: the port speaks wss only, and a client
   * that opens with anything but a TLS handshake is dropped.
   */
  tls?: { key: string; cert: string };
  /**
   * The trusted phone certificates, shared with PhoneLink. A wss client gets in
   * only with a pinned client cert. Without a store the set lasts only as long
   * as the process.
   */
  pins?: PinStore;
  /**
   * The pairing window: an unpinned client cert that reaches it gets a SAS
   * session instead of a hello, and nothing else. Without it no new phone can
   * pair over wss.
   */
  pairing?: PairingCoordinator;
  /** How long a pairing may go unused before the phone must pair again; read live, since the phone can change it. */
  pairingTtlMs?: () => number;
  /** Test seam: the clock the pairing TTL is judged by. */
  now?: () => number;
  /**
   * The steering secret, read at each hello so a rotation takes effect at once.
   * A hello without it is refused. It is never sent.
   */
  steer?: () => string | undefined;
  /** The file behind `steer`, watched so a rotation drops the phones that held the old secret. */
  steerFile?: string;
  /** How often live clients are re-checked against the current secret (the file watch also triggers it). */
  trustCheckIntervalMs?: number;
  v2?: PhoneV2Hooks;
  /**
   * Where phones should dial now (`advertisedEndpoint`). Each accepted client is
   * sent it as an `endpoint` frame after its snapshot, and again when it changes.
   */
  endpoint?: () => { hosts: readonly string[]; port: number };
  /** How often a changed `endpoint` is looked for while clients are linked. */
  endpointCheckIntervalMs?: number;
  /** A client finished its handshake, after it has its snapshot. `trusted` is whether it may steer: always, for an accepted client. */
  onClientConnected?: (trusted: boolean) => void;
  /** An authenticated client went away. */
  onClientDisconnected?: () => void;
  /** A client lost its trust (the secret was rotated or its phone forgotten); it is being dropped. */
  onTrustRevoked?: () => void;
}


/** The SHA-256 of the client cert the peer presented, or undefined when it presented none. */
function clientCertFingerprint(socket: TLSSocket): string | undefined {
  const cert = socket.getPeerCertificate(true);
  if (!cert || !cert.raw || cert.raw.length === 0) {
    return undefined;
  }
  return normalizeFingerprint(createHash("sha256").update(cert.raw).digest("hex"));
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
  private server?: https.Server;
  private sockets?: WebSocketServer;
  private keepaliveTimer?: NodeJS.Timeout;
  private stopTrustWatch?: () => void;
  private endpointTimer?: NodeJS.Timeout;
  private readonly clients = new Map<WebSocket, ClientState>();
  private sequence = 0;
  private readonly unsubscribeUpsert: () => void;
  private readonly unsubscribeRemoved: () => void;
  private readonly pins: PinStore;
  private readonly now: () => number;
  private readonly tls: { key: string; cert: string };
  private readonly agentdFingerprint: string;

  constructor(
    private readonly config: AgentConfig,
    private readonly store: SessionStore,
    private readonly logger: Logger,
    private readonly options: WsHubOptions = {},
  ) {
    if (!options.tls) {
      throw new Error("WsHub needs agentd's TLS identity: the phone port is wss only");
    }
    this.tls = options.tls;
    this.agentdFingerprint = fingerprintOfCert(options.tls.cert);
    this.pins = options.pins ?? new PinStore();
    this.now = options.now ?? Date.now;
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
    const sockets = new WebSocketServer({ noServer: true });
    // The phone's cert is self-signed and may be missing altogether, so the
    // handshake asks for it and admits either; the hello decides, where a
    // refusal can say what to do next.
    const server = https.createServer(
      {
        ...this.tls,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        handshakeTimeout: this.options.helloTimeoutMs ?? 5000,
      },
      refuseHttp,
    );
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      sockets.handleUpgrade(request, socket, head, (client) => this.accept(client, request));
    });
    // Node destroys the socket after this without writing a byte, so a
    // plaintext client never gets an answer, let alone one to send a token to.
    server.on("tlsClientError", (error: NodeJS.ErrnoException) => {
      if (error.code !== undefined && PLAINTEXT_ERRORS.has(error.code)) {
        this.logger.warn("ws_plaintext_refused");
      } else {
        this.logger.warn("ws_tls_client_error", { reason: error.name });
      }
    });
    this.server = server;
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
        if (this.options.endpoint) {
          this.endpointTimer = setInterval(() => this.broadcastEndpoint(), this.options.endpointCheckIntervalMs ?? 15_000);
          this.endpointTimer.unref();
        }
        this.stopTrustWatch = watchFiles(
          [this.options.steerFile, this.pins.filePath].filter((file): file is string => file !== undefined),
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

  port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address !== "string" ? (address as AddressInfo).port : undefined;
  }

  async stop(): Promise<void> {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = undefined;
    }
    if (this.endpointTimer) {
      clearInterval(this.endpointTimer);
      this.endpointTimer = undefined;
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
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    }
    this.unsubscribeUpsert();
    this.unsubscribeRemoved();
  }

  private accept(socket: WebSocket, request: IncomingMessage): void {
    const helloTimer = setTimeout(() => {
      if (!this.clients.get(socket)?.authenticated) {
        socket.close(4408, "hello timeout");
      }
    }, this.options.helloTimeoutMs ?? 5000);
    helloTimer.unref();
    const hub = this;
    const state: ClientState = {
      authenticated: false,
      peerFingerprint: clientCertFingerprint(request.socket as TLSSocket),
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
    state.sas = this.pairingSession(socket, state);
    if (state.sas) {
      clearTimeout(helloTimer);
    }

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
      if (state) {
        this.options.v2?.channelClosed?.(state.channel);
      }
      state?.sas?.disconnected();
      if (state?.authenticated) {
        this.options.onClientDisconnected?.();
      }
    });
  }

  /**
   * Before a pin, a peer's cert is accepted only for SAS frames, and only
   * while the window is open (or an attempt runs, which this second peer then
   * aborts). A pinned or provisional cert is never a pairing peer.
   */
  private pairingSession(socket: WebSocket, state: ClientState): PairingSession | undefined {
    const pairing = this.options.pairing;
    const fingerprint = state.peerFingerprint;
    if (!pairing || !fingerprint || this.isPinned(state) || pairing.provisionalFor(fingerprint) || !pairing.accepts()) {
      return undefined;
    }
    const session = pairing.beginSession({
      transport: "wshub",
      agentdFp: this.agentdFingerprint,
      phoneFp: fingerprint,
      send: (frame) => this.send(socket, frame),
      close: () => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, "pairing session ended");
        }
      },
    });
    if (!session) {
      socket.close(CLOSE_UNTRUSTED, "pairing refused");
    }
    return session;
  }

  private onMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    const state = this.clients.get(socket);
    if (!state) {
      return;
    }
    if (state.sas) {
      // Anything that is not a SAS frame ends the attempt.
      let frame: Record<string, unknown> = {};
      if (!isBinary) {
        try {
          const parsed: unknown = JSON.parse(data.toString());
          frame = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        } catch {
          frame = {};
        }
      }
      state.sas.receive(frame);
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
      if (message.type !== "hello" || message.v !== PROTOCOL_VERSION) {
        // A phone treats 4401 as final and stops reconnecting: this is not a
        // phone speaking this protocol at all.
        this.logger.warn("ws_auth_rejected", {
          reason: message.type !== "hello" ? "not_hello" : "version",
        });
        socket.close(4401, "authentication failed");
        return;
      }
      this.onHello(socket, state, message);
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
   * A hello is accepted only with the token, the steering secret and a client
   * cert that is pinned or may be pinned now, checked in that order. Then the
   * one commit point: all three are checked again, and only if they still hold
   * is the cert pinned and the window spent. Nothing after the pin refuses, so a
   * failed hello leaves pins and window as they were, even when the secret is
   * rotated or the phone forgotten while it is being admitted.
   */
  private onHello(socket: WebSocket, state: ClientState, message: Record<string, unknown>): void {
    const fingerprint = state.peerFingerprint;
    const short = fingerprint ? shortFingerprint(fingerprint) : "none";
    let verdict: Admission;
    try {
      verdict = this.admission(message, fingerprint);
      if (verdict.ok) {
        verdict = this.admission(message, fingerprint);
      }
      // Recovery admission (6a-R4′): a provisional cert's hello with the token
      // and the steering secret proves the phone stored the credentials, so its
      // pin becomes durable here. A promotion that fails admits nobody.
      if (verdict.ok && verdict.recovery && fingerprint && !this.options.pairing?.promote(fingerprint, verdict.recovery, "recovery_hello")) {
        verdict = { ok: false, reason: "repair_needed", log: "pins_unavailable" };
      }
    } catch (error) {
      // Fail closed: with the set unreadable, or a pin it cannot keep, nobody can be told from a stranger.
      this.logger.error("ws_pins_unavailable", {
        reason: error instanceof Error ? error.message : String(error),
      });
      this.rejectHello(socket, state, "repair_needed", { reason: "pins_unavailable", fingerprint: short });
      return;
    }
    if (!verdict.ok) {
      this.rejectHello(socket, state, verdict.reason, { reason: verdict.log, fingerprint: short });
      return;
    }
    // Past the commit point: a rotation or a forget from here on is the live re-check's to act on.
    const digest = secretDigest(message.steer as string);
    state.authenticated = true;
    state.steerDigest = digest;
    state.lastPongAt = Date.now();
    clearTimeout(state.helloTimer);
    this.armPongDeadline(socket, state);
    this.send(socket, {
      type: "hello_ack",
      v: PROTOCOL_VERSION,
      // The grant, stated (R126): the phone binds steering from this. An
      // accepted link always steers; the field stays for phones that read it.
      steering: true,
      server: {
        name: "nexus-agentd",
        version: SERVER_VERSION,
        machineId: this.config.machineId,
        machineName: this.config.machineName,
      },
    });
    this.sendSnapshot(socket);
    this.sendEndpoint(socket, state);
    this.options.onClientConnected?.(this.isTrusted(state));
    // Admitted: this is a use of the pairing.
    this.touchPairing(state);
  }

  /**
   * Records a use of the phone's pairing, for a client that is trusted right
   * now (a stale pairing is forgotten, not renewed). The store writes at most
   * once an hour per phone; a failed write only costs the record, never the link.
   */
  private touchPairing(state: ClientState): void {
    if (!state.peerFingerprint) {
      return;
    }
    try {
      if (this.isTrusted(state)) {
        this.pins.touch(state.peerFingerprint, this.now());
      }
    } catch (error) {
      this.logger.warn("ws_pairing_touch_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Tells the phone why, then closes; never echoes the token, the secret or the full fingerprint. */
  private rejectHello(
    socket: WebSocket,
    state: ClientState,
    reason: HelloRejectReason,
    log: { reason: string; fingerprint: string },
  ): void {
    clearTimeout(state.helloTimer);
    this.logger.warn("ws_auth_rejected", log);
    this.send(socket, { type: "hello_reject", v: 2, reason });
    socket.close(CLOSE_UNTRUSTED, reason);
  }

  /** The hello's checks, in order, reading the secret and the pins afresh; changes nothing. */
  private admission(message: Record<string, unknown>, fingerprint: string | undefined): Admission {
    if (!tokenMatches(message.token, this.config.token)) {
      return { ok: false, reason: "bad_token", log: "token" };
    }
    if (!this.steerMatches(message.steer)) {
      return { ok: false, reason: "repair_needed", log: "steer" };
    }
    if (!fingerprint) {
      return { ok: false, reason: "repair_needed", log: "no_client_cert" };
    }
    // Stale counts as unpinned (and is forgotten on the spot): an expired phone cannot renew itself by reconnecting.
    // A new phone never gets in by a hello: it pairs by SAS, so a window no longer trusts on first use.
    if (this.pins.isTrusted(fingerprint, this.now(), this.pairingTtlMs())) {
      return { ok: true };
    }
    const provisional = this.options.pairing?.provisionalFor(fingerprint);
    if (provisional) {
      return { ok: true, recovery: provisional.attempt };
    }
    return { ok: false, reason: "repair_needed", log: "unpinned_cert" };
  }

  private pairingTtlMs(): number {
    return this.options.pairingTtlMs?.() ?? DEFAULT_PAIRING_TTL_DAYS * DAY_MS;
  }

  /** Constant time, and a length mismatch is just a mismatch. */
  private steerMatches(presented: unknown): boolean {
    const expected = this.options.steer?.();
    return typeof presented === "string" && expected !== undefined && secretMatches(presented, expected);
  }

  private isPinned(state: ClientState): boolean {
    if (!state.peerFingerprint) {
      return false;
    }
    try {
      return this.pins.isTrusted(state.peerFingerprint, this.now(), this.pairingTtlMs());
    } catch {
      return false;
    }
  }

  /** Live: the secret the client proved must still be the current one, and its cert still pinned. */
  private isTrusted(state: ClientState): boolean {
    return (
      state.steerDigest !== undefined &&
      digestMatchesSecret(state.steerDigest, this.options.steer?.()) &&
      this.isPinned(state)
    );
  }

  /**
   * Drops clients whose secret has been rotated away or whose phone has been
   * forgotten. The close frame gets a moment to reach the phone, then the
   * socket is destroyed: a client that never answers it would otherwise stay
   * listed for ws's 30 s close timeout. Its digest is dropped at once, so it is
   * untrusted from here, and revoked, and logged, once.
   */
  private recheckTrust(): void {
    let revoked = false;
    for (const [socket, state] of this.clients) {
      if (state.authenticated && state.steerDigest !== undefined && !this.isTrusted(state)) {
        const reason = this.isPinned(state) ? "steer_rotated" : "pin_forgotten";
        state.steerDigest = undefined;
        revoked = true;
        this.logger.warn("ws_trust_revoked", {
          reason,
          fingerprint: state.peerFingerprint ? shortFingerprint(state.peerFingerprint) : "none",
        });
        // Said before the close, so the phone stops treating the link as steering (R126).
        this.send(socket, linkTrustFrame(false));
        socket.close(CLOSE_UNTRUSTED, reason === "steer_rotated" ? "steering secret rotated" : "phone forgotten");
        setTimeout(() => socket.terminate(), REVOKED_CLOSE_GRACE_MS).unref();
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

  /** Approvals, alerts and their resolutions go to trusted phones only: one losing its trust cannot answer them. */
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
      // A link that stays up keeps its pairing in use.
      this.touchPairing(state);
    }
  }

  /** Tells one authenticated client where to dial, unless it already has exactly this. */
  private sendEndpoint(socket: WebSocket, state: ClientState): void {
    if (!this.options.endpoint) {
      return;
    }
    try {
      const frame = endpointFrame(this.options.endpoint());
      const serialized = JSON.stringify(frame);
      if (serialized !== state.lastEndpoint) {
        state.lastEndpoint = serialized;
        this.send(socket, frame);
      }
    } catch (error) {
      // An endpoint that cannot be worked out costs the phone a hint, never the link.
      this.logger.warn("ws_endpoint_unavailable", { reason: error instanceof Error ? error.name : "error" });
    }
  }

  /** The host list may change while phones are linked (Wi-Fi moved, Tailscale came up). */
  private broadcastEndpoint(): void {
    for (const [socket, state] of this.clients) {
      if (state.authenticated && socket.readyState === WebSocket.OPEN) {
        this.sendEndpoint(socket, state);
      }
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
