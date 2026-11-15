import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir, networkInterfaces, platform } from "node:os";
import type { Socket as TcpSocket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type {
  ApprovalDecision,
  ApprovalOutcome,
  ApprovalRequest,
} from "./approval-manager";
import { NotAttachedError } from "./attach-registry";
import { parsePhoneTarget, readPhoneLinkConfig } from "./config";
import type { PairingCoordinator, PairingSession } from "./pairing/coordinator";
import { gateFrame, linkTrustFrame, type PhoneChannel, type PhoneV2Hooks } from "./protocol-v2";
import {
  listDirectory,
  listRoots,
  validateExistingDirectory,
  type FsListing,
} from "./fs-browse";
import type { SessionStore } from "./session-store";
import type { TerminalInputOutcome } from "./terminal-input";
import { TailscalePeerDiscovery } from "./tailnet-discovery";
import {
  DAY_MS,
  DEFAULT_PAIRING_TTL_DAYS,
  PinStore,
  fingerprintOfCert,
  shortFingerprint,
  watchFiles,
} from "./tls";
import { DETAIL_MESSAGE_LIMIT } from "./transcript-messages";
import type {
  AgentConfig,
  AgentProvider,
  Logger,
  Session,
  SessionMessage,
  ThreadStartResult,
} from "./types";

/**
 * Outbound link to the phone.
 *
 * The daemon is the CLIENT here even though it owns the data: Windows blocks
 * unsolicited inbound connections unless an administrator adds a firewall rule,
 * while outbound connections and the unicast replies to a broadcast we just sent
 * are allowed by default. Android has no such filter, so the phone listens and
 * the PC dials — no rule, no cable, nothing to configure.
 */
export const DISCOVERY_PORT = 8793;
const DISCOVERY_INTERVAL_MS = 2000;
export const TAILNET_REFRESH_INTERVAL_MS = 60_000;
const RECONNECT_DELAY_MS = 3000;
export const PHONE_HELLO_TIMEOUT_MS = 15_000;
export const REFUSAL_RECONNECT_DELAY_MS = 60_000;
const MAX_LINE_BYTES = 512 * 1024;
export const MAX_PHONE_SESSIONS_PER_PROVIDER = 200;
export const THREAD_START_TIMEOUT_MS = 30_000;
export const CODEX_DETAIL_REFRESH_DELAY_MS = 1_000;
/** The phone's read loop times out at 90s; two of these fit inside it. */
const LINK_PING_INTERVAL_MS = 30_000;
const TRUST_CHECK_INTERVAL_MS = 1_000;
const MAX_THREAD_PROMPT_BYTES = 16 * 1024;

export interface PhoneLinkOptions {
  config: AgentConfig;
  store: SessionStore;
  logger: Logger;
  detailProvider: (sessionId: string, limit: number) => Promise<SessionMessage[]>;
  onDetailOpen?: (sessionId: string) => void;
  onApprovalDecision?: (requestId: string, decision: ApprovalDecision) => void;
  /** Types the wearer's text into the session's terminal; see terminal-input. */
  onTerminalInput?: (sessionId: string, text: string) => Promise<TerminalInputOutcome>;
  onThreadStart?: (
    provider: AgentProvider,
    path: string,
    prompt: string,
  ) => Promise<ThreadStartResult>;
  /** `trusted` is whether the link that came up may steer. */
  onConnected?: (trusted: boolean) => void;
  /** `wasTrusted` is whether the link that went away was a pinned-TLS one. */
  onDisconnected?: (wasTrusted: boolean) => void;
  /** The linked phone was forgotten; its link is being dropped. */
  onTrustRevoked?: () => void;
  /**
   * The trusted phone certificates. A link is trusted, and so may steer, only
   * when it is TLS and its peer cert is in the set. A cert joins the set only
   * through a SAS pairing (`pairing`), never by a hello. Without a store the
   * set lasts only as long as the process.
   */
  pins?: PinStore;
  /**
   * The pairing window. Inside it, a phone whose cert is not pinned and that
   * says its door is open (or that the owner configured by address) is dialled
   * for a SAS session instead of a hello. A phone pinned only provisionally
   * must prove it stored its credentials before it is sent a hello.
   */
  pairing?: PairingCoordinator;
  /** How long a pairing may go unused before the phone must pair again; read live, since the phone can change it. */
  pairingTtlMs?: () => number;
  /**
   * agentd's own identity, presented as the TLS client certificate when it
   * dials a phone, so the phone can pin this computer too (R114).
   */
  clientCert?: { key: string; cert: string };
  v2?: PhoneV2Hooks;
  operatorMessage?: (message: string) => void;
  discoveryPort?: number;
  helloTimeoutMs?: number;
  /** How often a live link re-checks that its phone is still trusted (a file watch also triggers it). */
  trustCheckIntervalMs?: number;
  /** How often a live link pings, which is also when it keeps its pairing in use. Test seam. */
  pingIntervalMs?: number;
  reconnectDelayMs?: number;
  targetRefreshIntervalMs?: number;
  threadStartTimeoutMs?: number;
  codexDetailRefreshDelayMs?: number;
  configFilePath?: string;
  tailnetDiscovery?: TailnetPeerSource;
  now?: () => number;
}

export interface TailnetPeerSource {
  discover(): Promise<string[]>;
}

interface PhoneAnnouncement {
  host: string;
  port: number;
  name: string;
  /** The phone said its door is open (Add a computer, or onboarding's pairing step). */
  pairing?: boolean;
}

/** A UDP announcement also says whether the phone serves TLS: false when the field is absent. */
interface UdpAnnouncement extends PhoneAnnouncement {
  tls: boolean;
}

/** What a dialled peer's cert allows before anything is written to it. */
type PeerVerdict = "pinned" | "provisional" | "pairing";

interface RejectedPhone {
  retryAt: number;
  reportedReason: string;
}

function parseAnnouncement(raw: Buffer, host: string): UdpAnnouncement | undefined {
  try {
    const value: unknown = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (record.nexus !== "agents-phone") {
      return undefined;
    }
    const port = typeof record.port === "number" ? record.port : undefined;
    if (!port || port < 1 || port > 65535) {
      return undefined;
    }
    return {
      host,
      port,
      name: typeof record.name === "string" ? record.name.slice(0, 64) : "phone",
      tls: record.tls === true,
      pairing: record.pairing === true,
    };
  } catch {
    return undefined;
  }
}

/** Broadcast addresses of every IPv4 interface, plus the global fallback. */
function broadcastTargets(): string[] {
  const targets = new Set<string>(["255.255.255.255"]);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal || !address.netmask) {
        continue;
      }
      const ip = address.address.split(".").map(Number);
      const mask = address.netmask.split(".").map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some(isNaN) || mask.some(isNaN)) {
        continue;
      }
      targets.add(ip.map((part, index) => part | (~mask[index] & 0xff)).join("."));
    }
  }
  return [...targets];
}

function normalizedHost(host: string): string {
  return host.toLowerCase();
}

export function buildPhoneDialTargets(
  phoneHosts: readonly string[],
  discoveredTargets: readonly string[],
  unavailableHosts: ReadonlySet<string> = new Set(),
): PhoneAnnouncement[] {
  const configured: PhoneAnnouncement[] = [];
  const reservedHosts = new Set([...unavailableHosts].map(normalizedHost));
  for (const configuredTarget of phoneHosts) {
    const target = parsePhoneTarget(configuredTarget);
    if (target) {
      configured.push({ ...target, name: target.host });
      reservedHosts.add(normalizedHost(target.host));
    }
  }

  const discovered: PhoneAnnouncement[] = [];
  for (const discoveredTarget of discoveredTargets) {
    const target = parsePhoneTarget(discoveredTarget);
    if (!target || reservedHosts.has(normalizedHost(target.host))) {
      continue;
    }
    reservedHosts.add(normalizedHost(target.host));
    discovered.push({ ...target, name: target.host });
  }
  return [...configured, ...discovered];
}

export class PhoneLink {
  private discovery?: UdpSocket;
  private socket?: TcpSocket;
  private discoveryTimer?: NodeJS.Timeout;
  private targetRefreshTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private helloTimer?: NodeJS.Timeout;
  private detailRefreshTimer?: NodeJS.Timeout;
  private detailSendInFlight?: Promise<void>;
  private pendingDetailSessionId?: string;
  private pingTimer?: NodeJS.Timeout;
  private stopTrustWatch?: () => void;
  private buffer = "";
  private sequence = 0;
  private openSessionId?: string;
  private connectedTo?: string;
  private phoneName?: string;
  private authenticated = false;
  /** This connection's peer cert, set once a TLS handshake has passed the pin check. */
  private peerFingerprint?: string;
  /** This connection proved itself: TLS, pin matched, hello accepted. */
  private linkTrusted = false;
  /** Set while this connection is a SAS pairing session: every line is the session's. */
  private sas?: PairingSession;
  /** Set while a provisionally pinned phone owes its commit proof, before any hello. */
  private awaitingProof?: { fingerprint: string; attempt: string };
  private readonly pins: PinStore;
  private stopped = false;
  private unsubscribe?: () => void;
  private readonly rejectedPhones = new Map<string, RejectedPhone>();
  private readonly plaintextAnnouncers = new Set<string>();
  private readonly retryAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly tailnetPeerSource: TailnetPeerSource;
  private phoneHosts: string[];
  private tailnetDiscoveryEnabled: boolean;
  private discoveredPhoneTargets: string[] = [];
  private targetRefreshPromise?: Promise<void>;
  private targetRefreshGeneration = 0;
  private publishedSessions = new Map<string, Session>();
  /** The last session_upsert payload sent on this link, by session id, so an identical one is not sent again. */
  private lastUpserts = new Map<string, string>();
  /** The connection frames arrived on; see channelFor. */
  private channel?: PhoneChannel;

  constructor(private readonly options: PhoneLinkOptions) {
    this.pins = options.pins ?? new PinStore();
    this.now = options.now ?? Date.now;
    this.phoneHosts = [...options.config.phoneHosts];
    this.tailnetDiscoveryEnabled = options.config.tailnetDiscovery !== false;
    this.tailnetPeerSource = options.tailnetDiscovery ?? new TailscalePeerDiscovery(options.logger);
  }

  start(): void {
    this.stopped = false;
    this.targetRefreshGeneration += 1;
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    this.discovery = socket;
    socket.on("error", (error) => {
      this.options.logger.warn("discovery_socket_error", { reason: error.name });
    });
    socket.on("message", (message, remote) => {
      if (this.socket) {
        return;
      }
      const announcement = parseAnnouncement(message, remote.address);
      if (!announcement) {
        return;
      }
      if (!announcement.tls) {
        this.ignorePlaintextAnnouncement(`${announcement.host}:${announcement.port}`);
        return;
      }
      this.connectToPhone(announcement);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      this.announce();
      this.discoveryTimer = setInterval(() => this.announce(), DISCOVERY_INTERVAL_MS);
      this.discoveryTimer.unref();
    });
    void this.refreshTargets();
    this.targetRefreshTimer = setInterval(
      () => void this.refreshTargets(),
      this.options.targetRefreshIntervalMs ?? TAILNET_REFRESH_INTERVAL_MS,
    );
    this.targetRefreshTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
    if (this.targetRefreshTimer) {
      clearInterval(this.targetRefreshTimer);
      this.targetRefreshTimer = undefined;
    }
    this.targetRefreshGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHelloTimer();
    this.clearDetailRefreshTimer();
    this.clearPingTimer();
    this.stopTrustWatch?.();
    this.stopTrustWatch = undefined;
    this.pendingDetailSessionId = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.sas?.disconnected();
    this.sas = undefined;
    this.awaitingProof = undefined;
    this.authenticated = false;
    this.linkTrusted = false;
    this.peerFingerprint = undefined;
    this.publishedSessions.clear();
    this.lastUpserts.clear();
    this.discovery?.close();
    this.discovery = undefined;
  }

  get connected(): boolean {
    return this.authenticated && this.socket !== undefined && !this.socket.destroyed;
  }

  /**
   * Whether this link may steer right now. Not fixed at connect: the peer's
   * cert must still be in the trusted set, so `phones forget` takes effect on a
   * live link at once (frames are refused, nothing trusted-only is sent) and
   * the link is then dropped by `recheckTrust`.
   */
  private get trusted(): boolean {
    if (!this.linkTrusted || !this.peerFingerprint) {
      return false;
    }
    try {
      return this.pins.isTrusted(this.peerFingerprint, this.now(), this.pairingTtlMs());
    } catch {
      return false;
    }
  }

  /** Drops a live link whose phone has been removed from the trusted set. */
  private recheckTrust(): void {
    if (this.linkTrusted && !this.trusted && this.socket && !this.socket.destroyed) {
      this.options.logger.warn("phone_link_trust_revoked", {
        target: this.connectedTo ?? "unknown",
        fingerprint: this.peerFingerprint ? shortFingerprint(this.peerFingerprint) : "none",
      });
      // Said before the drop, so the phone stops treating the link as steering (R126).
      this.write(linkTrustFrame(false));
      this.socket.destroy();
      this.options.onTrustRevoked?.();
    }
  }

  /** True while the link is up and has proved who it is, which is what may hold a tool call. */
  get trustedConnected(): boolean {
    return this.connected && this.trusted;
  }

  /** Approvals, alerts and their resolutions go to a trusted phone only: one losing its trust cannot answer them. */
  sendApprovalRequest(request: ApprovalRequest): boolean {
    return this.trusted && this.send({ ...request });
  }

  /** Any other frame for the phone, such as the v2 alert; false when the link is not up and trusted. */
  sendFrame(frame: Record<string, unknown>): boolean {
    return this.trusted && this.send(frame);
  }

  sendApprovalResolved(requestId: string, outcome: ApprovalOutcome): boolean {
    return this.trusted && this.send({ type: "approval_resolved", v: 1, requestId, outcome });
  }

  /** Streams an appended conversation message if the phone is reading that session. */
  sendDetailMessage(sessionId: string, message: SessionMessage): void {
    if (this.openSessionId === sessionId) {
      this.send({
        type: "detail_append",
        sessionId,
        provider: this.options.store.get(sessionId)?.provider ?? "claude",
        message,
      });
    }
  }

  async refreshTargets(): Promise<void> {
    if (this.targetRefreshPromise) {
      return this.targetRefreshPromise;
    }
    const refresh = this.doRefreshTargets();
    this.targetRefreshPromise = refresh;
    try {
      await refresh;
    } finally {
      if (this.targetRefreshPromise === refresh) {
        this.targetRefreshPromise = undefined;
      }
    }
  }

  private async doRefreshTargets(): Promise<void> {
    if (this.options.configFilePath) {
      try {
        const config = readPhoneLinkConfig(this.options.configFilePath);
        this.phoneHosts = config.phoneHosts;
        this.tailnetDiscoveryEnabled = config.tailnetDiscovery;
      } catch {
        // Atomic saves can briefly hide the file; retain the last good dial settings.
      }
    }

    const generation = this.targetRefreshGeneration;
    let discoveredTargets: string[] = [];
    if (this.tailnetDiscoveryEnabled) {
      try {
        discoveredTargets = await this.tailnetPeerSource.discover();
      } catch {
        // Discovery is optional and must not affect the daemon lifecycle.
      }
    }
    if (this.stopped || generation !== this.targetRefreshGeneration) {
      return;
    }
    this.discoveredPhoneTargets = discoveredTargets;
    this.announce();
  }

  private broadcast(payload: Buffer): void {
    const port = this.options.discoveryPort ?? DISCOVERY_PORT;
    for (const target of broadcastTargets()) {
      this.discovery?.send(payload, port, target, (error) => {
        if (error) {
          this.options.logger.warn("discovery_send_failed", { target, reason: error.name });
        }
      });
    }
  }

  private announce(): void {
    if (!this.discovery) {
      return;
    }
    // While the window waits for a phone, a phone on its pairing screen may dial
    // agentd's wss instead; this says where. It carries no secret. Sent even
    // while a paired phone holds the link: pairing another is not that link's.
    const ready = this.options.pairing?.pairReady();
    if (ready) {
      this.broadcast(Buffer.from(JSON.stringify(ready)));
    }
    if (this.socket) {
      return;
    }
    this.broadcast(
      Buffer.from(
        JSON.stringify({
          nexus: "agentd",
          v: 1,
          machineId: this.options.config.machineId,
          machineName: this.options.config.machineName,
        }),
      ),
    );
    for (const target of buildPhoneDialTargets(
      this.phoneHosts,
      this.discoveredPhoneTargets,
      this.backingOffHosts(),
    )) {
      this.connectToPhone(target);
      if (this.socket) {
        break;
      }
    }
  }

  private backingOffHosts(): Set<string> {
    const hosts = new Set<string>();
    const now = this.now();
    for (const [target, retryAt] of this.rejectedPhones) {
      if (retryAt.retryAt > now) {
        const parsed = parsePhoneTarget(target);
        if (parsed) {
          hosts.add(parsed.host);
        }
      }
    }
    for (const [target, retryAt] of this.retryAt) {
      if (retryAt > now) {
        const parsed = parsePhoneTarget(target);
        if (parsed) {
          hosts.add(parsed.host);
        }
      }
    }
    if (this.connectedTo) {
      const parsed = parsePhoneTarget(this.connectedTo);
      if (parsed) {
        hosts.add(parsed.host);
      }
    }
    return hosts;
  }

  private connectToPhone(announcement: PhoneAnnouncement): void {
    if (this.socket || this.stopped) {
      return;
    }
    const target = `${announcement.host}:${announcement.port}`;
    const now = this.now();
    const refused = this.rejectedPhones.get(target);
    // A phone refused for its unknown cert is worth one more dial once a window opens: that is how it pairs.
    if (refused && refused.retryAt > now && !(refused.reportedReason === "untrusted_peer" && this.mayPair(announcement))) {
      return;
    }
    if ((this.retryAt.get(target) ?? 0) > now) {
      return;
    }
    // With the trusted set unreadable no peer could be told from a stranger, so nothing is dialled.
    try {
      this.pins.everPinned();
    } catch (error) {
      this.pinsUnreadable(error);
      return;
    }
    // Every dial is TLS: a plaintext one would put the token on the wire for
    // whoever answered. The phone's cert is self-signed, so chain validation
    // cannot pass; the pinned set (checked below) is the identity check. Node
    // skips checkServerIdentity when validation failed, which is why it is not used.
    const socket: TcpSocket = tlsConnect({
      host: announcement.host,
      port: announcement.port,
      rejectUnauthorized: false,
      key: this.options.clientCert?.key,
      cert: this.options.clientCert?.cert,
    });
    this.socket = socket;
    this.channel = this.channelFor(socket);
    this.connectedTo = target;
    this.phoneName = announcement.name;
    this.authenticated = false;
    this.linkTrusted = false;
    this.peerFingerprint = undefined;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    // A peer that accepts TCP and never finishes the handshake would hold
    // this.socket, and with it every later dial, for good. The deadline runs
    // from the dial, covering the handshake and then the hello.
    this.helloTimer = setTimeout(
      () => this.onHelloTimeout(socket),
      this.options.helloTimeoutMs ?? PHONE_HELLO_TIMEOUT_MS,
    );
    this.helloTimer.unref();
    socket.on("secureConnect", () => {
      switch (this.verifyPeer(socket as TLSSocket, target, announcement)) {
        case "pinned":
          this.writeHello();
          break;
        case "provisional":
          // 6a-R4″: this hello would carry no steering secret, so it proves nothing.
          // The phone proves it stored its credentials first, on this pinned session.
          this.write({ type: "pair_commit_query", v: 2, attempt: this.awaitingProof?.attempt });
          break;
        case "pairing":
          this.beginPairing(socket as TLSSocket);
          break;
        default:
          break;
      }
    });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => {
      // name alone is "Error" for every socket failure, which says nothing
      // about whether the phone reset the link, went unreachable, or refused
      // the dial. The errno code is the part worth having in a log.
      this.options.logger.warn("phone_link_error", {
        reason: error.name,
        code: (error as NodeJS.ErrnoException).code ?? "none",
      });
    });
    socket.on("close", () => this.onClose());
  }

  /** A phone that announces no TLS is not dialled at all; said once per announcer, as they repeat every few seconds. */
  private ignorePlaintextAnnouncement(target: string): void {
    if (this.plaintextAnnouncers.has(target)) {
      return;
    }
    this.plaintextAnnouncers.add(target);
    this.options.logger.warn("phone_announcement_plaintext_ignored", { target });
  }

  private pairingTtlMs(): number {
    return this.options.pairingTtlMs?.() ?? DEFAULT_PAIRING_TTL_DAYS * DAY_MS;
  }

  /**
   * Records a use of the phone's pairing while the link is trusted right now (a
   * stale pairing is forgotten, not renewed). The store writes at most once an
   * hour per phone; a failed write only costs the record, never the link.
   */
  private touchPairing(): void {
    const fingerprint = this.peerFingerprint;
    if (!fingerprint || !this.linkTrusted) {
      return;
    }
    try {
      if (this.trusted) {
        this.pins.touch(fingerprint, this.now());
      }
    } catch (error) {
      this.options.logger.warn("phone_link_pairing_touch_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private hasTrustedPhones(): boolean {
    try {
      return this.pins.everPinned();
    } catch {
      return true;
    }
  }

  private pinsUnreadable(error: unknown): void {
    // Fail closed: with the set unreadable nobody can be told from a stranger.
    this.options.logger.error("phone_link_pins_unreadable", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Holds the dialled phone to the trusted set before anything is sent: a cert
   * in the set is fine at any address; a provisional one must first prove its
   * commit; an unknown one is fine only for a SAS session, inside the pairing
   * window. Undefined means the link was refused and destroyed, with no hello
   * and so no token written.
   */
  private verifyPeer(socket: TLSSocket, target: string, announcement: PhoneAnnouncement): PeerVerdict | undefined {
    const actual = socket.getPeerCertificate().fingerprint256;
    let verdict: PeerVerdict | undefined;
    try {
      verdict = actual !== undefined && actual !== "" ? this.verdictFor(actual, announcement) : undefined;
    } catch (error) {
      this.pinsUnreadable(error);
    }
    if (verdict) {
      this.peerFingerprint = actual;
      return verdict;
    }
    // Fingerprint only, shortened; the token is never part of a log line.
    this.options.logger.warn("phone_link_untrusted_peer", {
      target,
      fingerprint: actual ? shortFingerprint(actual) : "none",
    });
    this.rejectedPhones.set(target, {
      retryAt: this.now() + REFUSAL_RECONNECT_DELAY_MS,
      reportedReason: "untrusted_peer",
    });
    this.tellOperator(
      "A phone presented a TLS certificate agentd does not trust, so the link was refused before any token was sent. To add a phone, run `agentd pair` and open Add a computer on the phone, then compare the 6-digit codes. List trusted phones with `agentd phones list`.",
    );
    socket.destroy();
    return undefined;
  }

  private verdictFor(fingerprint: string, announcement: PhoneAnnouncement): PeerVerdict | undefined {
    // Stale counts as unpinned (and is forgotten on the spot): an expired phone cannot renew itself by reconnecting.
    if (this.pins.isTrusted(fingerprint, this.now(), this.pairingTtlMs())) {
      return "pinned";
    }
    const provisional = this.options.pairing?.provisionalFor(fingerprint);
    if (provisional) {
      this.awaitingProof = { fingerprint, attempt: provisional.attempt };
      return "provisional";
    }
    return this.mayPair(announcement) ? "pairing" : undefined;
  }

  /** Inside the window, and a phone that opened its door (or that the owner named by address). */
  private mayPair(announcement: PhoneAnnouncement): boolean {
    return (
      this.options.pairing?.accepts() === true &&
      this.options.clientCert !== undefined &&
      (announcement.pairing === true || this.isConfiguredTarget(announcement))
    );
  }

  private isConfiguredTarget(announcement: PhoneAnnouncement): boolean {
    return this.phoneHosts.some((entry) => {
      const target = parsePhoneTarget(entry);
      return target !== undefined && normalizedHost(target.host) === normalizedHost(announcement.host) && target.port === announcement.port;
    });
  }

  private writeHello(): void {
    this.write({
      type: "hello",
      v: 1,
      machineId: this.options.config.machineId,
      machineName: this.options.config.machineName,
      token: this.options.config.token,
    });
  }

  /** The SAS session on this dial: no hello, no token, only the pairing frames until it ends. */
  private beginPairing(socket: TLSSocket): void {
    const pairing = this.options.pairing;
    const clientCert = this.options.clientCert;
    const phoneFp = this.peerFingerprint;
    if (!pairing || !clientCert || !phoneFp) {
      socket.destroy();
      return;
    }
    // The attempt has its own deadline; the hello one would cut the humans short.
    this.clearHelloTimer();
    const session = pairing.beginSession({
      transport: "phonelink",
      agentdFp: fingerprintOfCert(clientCert.cert),
      phoneFp,
      send: (frame) => {
        if (this.socket === socket) {
          this.write(frame);
        }
      },
      close: () => {
        // Ended, either way: let the pairing frames reach the phone before the socket goes.
        socket.end();
        setTimeout(() => socket.destroy(), 200).unref();
      },
    });
    if (!session) {
      socket.destroy();
      return;
    }
    this.sas = session;
  }

  /** The provisional phone's answer: a valid proof makes its pin durable, and only then is it sent a hello. */
  private onCommitProof(message: Record<string, unknown>): void {
    const owed = this.awaitingProof;
    const clientCert = this.options.clientCert;
    this.awaitingProof = undefined;
    const valid =
      owed !== undefined &&
      clientCert !== undefined &&
      message.type === "pair_committed" &&
      this.options.pairing?.proofValid(owed.fingerprint, fingerprintOfCert(clientCert.cert), message.attempt, message.proof) === true &&
      this.options.pairing.promote(owed.fingerprint, owed.attempt, "recovery_proof");
    if (!valid) {
      this.options.logger.warn("phone_link_commit_proof_refused", {
        target: this.connectedTo ?? "unknown",
        fingerprint: owed ? shortFingerprint(owed.fingerprint) : "none",
      });
      if (this.connectedTo) {
        this.rejectedPhones.set(this.connectedTo, { retryAt: this.now() + REFUSAL_RECONNECT_DELAY_MS, reportedReason: "bad_commit_proof" });
      }
      this.socket?.destroy();
      return;
    }
    this.writeHello();
  }

  /**
   * The frame handlers' view of one connection. A reply made after an await
   * (a Codex follow-up, a model list) goes to the connection the frame came in
   * on or nowhere, never to whatever link has replaced it since.
   */
  private channelFor(socket: TcpSocket): PhoneChannel {
    const isCurrent = (): boolean => this.socket === socket;
    const isTrusted = (): boolean => isCurrent() && this.trusted;
    return {
      transport: "phonelink",
      get trusted() {
        return isTrusted();
      },
      send: (frame) => {
        if (isCurrent()) {
          void this.send(frame);
        }
      },
    };
  }

  private subscribe(): () => void {
    const upsert = this.options.store.onUpsert((session) => this.reconcileSessions(session.id));
    const removed = this.options.store.onRemoved((sessionId) => this.reconcileSessions(sessionId));
    return () => {
      upsert();
      removed();
    };
  }

  private onClose(): void {
    const wasAuthenticated = this.authenticated;
    const wasTrusted = this.linkTrusted;
    const target = this.connectedTo;
    const sas = this.sas;
    this.sas = undefined;
    this.awaitingProof = undefined;
    sas?.disconnected();
    this.clearHelloTimer();
    this.clearPingTimer();
    this.stopTrustWatch?.();
    this.stopTrustWatch = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.socket = undefined;
    this.authenticated = false;
    this.linkTrusted = false;
    this.peerFingerprint = undefined;
    this.publishedSessions.clear();
    this.lastUpserts.clear();
    this.buffer = "";
    this.clearDetailRefreshTimer();
    this.pendingDetailSessionId = undefined;
    this.openSessionId = undefined;
    this.connectedTo = undefined;
    this.phoneName = undefined;
    if (target && !this.rejectedPhones.has(target)) {
      this.retryAt.set(target, this.now() + (this.options.reconnectDelayMs ?? RECONNECT_DELAY_MS));
    }
    if (wasAuthenticated && target) {
      this.options.logger.info("phone_link_closed", { target });
      this.options.onDisconnected?.(wasTrusted);
    }
    if (!this.stopped) {
      // Discovery keeps running; give the phone a moment before dialling again.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = setTimeout(
        () => this.announce(),
        this.options.reconnectDelayMs ?? RECONNECT_DELAY_MS,
      );
      this.reconnectTimer.unref();
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.options.logger.warn("phone_link_flood");
      this.socket?.destroy();
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        // Before the pins a session takes SAS frames only: anything else ends it.
        this.sas?.receive({});
        return;
      }
      message = parsed as Record<string, unknown>;
    } catch {
      this.sas?.receive({});
      return;
    }
    if (this.sas) {
      this.sas.receive(message);
      return;
    }
    if (this.awaitingProof) {
      this.onCommitProof(message);
      return;
    }
    switch (message.type) {
      case "hello_ack":
        this.onHelloAck();
        break;
      case "hello_reject":
        this.onHelloReject(message.reason);
        break;
      default:
        if (!this.authenticated) {
          return;
        }
        this.handleAuthenticatedMessage(message);
        break;
    }
  }

  private handleAuthenticatedMessage(message: Record<string, unknown>): void {
    const channel = this.channel;
    // One gate for every frame, before any handler, v1 or v2.
    if (!channel || !gateFrame(message, channel) || this.options.v2?.handle(message, channel)) {
      return;
    }
    switch (message.type) {
      case "refresh":
        this.sendSnapshot();
        break;
      case "detail_open": {
        const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
        if (!sessionId) {
          break;
        }
        this.clearDetailRefreshTimer();
        this.pendingDetailSessionId = undefined;
        this.openSessionId = sessionId;
        this.options.logger.info("phone_link_detail_open", { sessionId: sessionId.slice(0, 8) });
        this.options.onDetailOpen?.(sessionId);
        this.queueDetailSend(sessionId);
        break;
      }
      case "detail_close":
        this.clearDetailRefreshTimer();
        this.pendingDetailSessionId = undefined;
        this.openSessionId = undefined;
        break;
      case "ping":
        this.send({ type: "pong", t: message.t });
        break;
      case "fs_list": {
        const id =
          typeof message.id === "string" && message.id.length > 0 && message.id.length <= 64
            ? message.id
            : undefined;
        const socket = this.socket;
        if (!id || !socket) {
          break;
        }
        void this.sendFsListing(socket, id, message.path);
        break;
      }
      case "thread_start": {
        const id =
          typeof message.id === "string" && message.id.length > 0 && message.id.length <= 64
            ? message.id
            : undefined;
        const socket = this.socket;
        if (!id || !socket) {
          break;
        }
        void this.sendThreadStarted(
          socket,
          id,
          message.provider,
          message.path,
          message.prompt,
        );
        break;
      }
      case "session_input": {
        const id =
          typeof message.id === "string" && message.id.length > 0 && message.id.length <= 64
            ? message.id
            : undefined;
        const socket = this.socket;
        if (!id || !socket) {
          break;
        }
        void this.sendTerminalInputResult(socket, id, message.sessionId, message.text);
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
        break;
    }
  }

  private onHelloAck(): void {
    if (this.authenticated || !this.socket || this.socket.destroyed) {
      return;
    }
    if (!this.trustPeer()) {
      // A peer that cannot be trusted is not a link at all.
      this.options.logger.warn("phone_link_untrusted_peer", {
        target: this.connectedTo ?? "unknown",
        fingerprint: this.peerFingerprint ? shortFingerprint(this.peerFingerprint) : "none",
      });
      this.socket.destroy();
      return;
    }
    this.authenticated = true;
    this.clearHelloTimer();
    if (this.connectedTo) {
      this.rejectedPhones.delete(this.connectedTo);
      this.retryAt.delete(this.connectedTo);
    }
    this.options.logger.info("phone_link_connected", {
      phone: this.phoneName ?? "phone",
      target: this.connectedTo ?? "unknown",
      trusted: this.linkTrusted,
    });
    this.sendSnapshot();
    this.unsubscribe = this.subscribe();
    // The phone hangs up after 90 quiet seconds; TCP keepalive never reaches
    // its read loop, so an idle board needs application-level pings.
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping", t: this.now() });
      // A link that stays up keeps its pairing in use.
      this.touchPairing();
    }, this.options.pingIntervalMs ?? LINK_PING_INTERVAL_MS);
    this.pingTimer.unref();
    const file = this.pins.filePath;
    this.stopTrustWatch = watchFiles(
      file ? [file] : [],
      this.options.trustCheckIntervalMs ?? TRUST_CHECK_INTERVAL_MS,
      () => this.recheckTrust(),
    );
    this.options.onConnected?.(this.linkTrusted);
    // Admitted: this is a use of the pairing.
    this.touchPairing();
  }

  /**
   * A hello_ack binds the link only for a cert that is pinned now. Nothing is
   * trusted on first use any more: a new phone's cert joins the set through a
   * SAS pairing, and a hello is never sent to one that has not.
   */
  private trustPeer(): boolean {
    const fingerprint = this.peerFingerprint;
    if (!fingerprint) {
      return false;
    }
    try {
      if (!this.pins.isTrusted(fingerprint, this.now(), this.pairingTtlMs())) {
        return false;
      }
    } catch (error) {
      this.pinsUnreadable(error);
      return false;
    }
    this.linkTrusted = true;
    return true;
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private onHelloReject(rawReason: unknown): void {
    if (this.authenticated || !this.connectedTo) {
      return;
    }
    const reason = rawReason === "bad_token" ? "bad_token" : "unknown_machine";
    const reportedReason = this.reasonKey(rawReason);
    const previous = this.rejectedPhones.get(this.connectedTo);
    this.rejectedPhones.set(this.connectedTo, {
      retryAt: this.now() + REFUSAL_RECONNECT_DELAY_MS,
      reportedReason,
    });

    if (!previous || previous.reportedReason !== reportedReason) {
      if (rawReason !== "unknown_machine" && rawReason !== "bad_token") {
        this.options.logger.warn("phone_link_reject_unknown_reason", {
          reason: rawReason,
          target: this.connectedTo,
        });
      }
      const message =
        reason === "bad_token"
          ? "The phone refused this computer because its saved token no longer matches, usually because the daemon identity was regenerated. On the phone, use Forget computers to clear it, then open Agents \u2192 Link a computer and start the daemon again."
          : "The phone refused this computer because it is not linked and the linking window is closed. On the phone, open Agents \u2192 Link a computer, then start the daemon again.";
      this.options.logger.warn("phone_link_rejected", {
        reason,
        rawReason,
        target: this.connectedTo,
        message,
      });
      this.tellOperator(message);
    }
    this.socket?.destroy();
  }

  private onHelloTimeout(socket: TcpSocket): void {
    if (this.socket !== socket || this.authenticated) {
      return;
    }
    this.options.logger.warn("phone_link_hello_timeout", {
      target: this.connectedTo ?? "unknown",
      timeoutMs: this.options.helloTimeoutMs ?? PHONE_HELLO_TIMEOUT_MS,
    });
    // While a phone is trusted, a TLS peer that stalls is not who we dial: back
    // off as for any refusal, or a host that keeps stalling holds the one link
    // slot for most of every cycle and starves the real phone.
    if (this.connectedTo && (socket as Partial<TLSSocket>).encrypted === true && this.hasTrustedPhones()) {
      this.rejectedPhones.set(this.connectedTo, {
        retryAt: this.now() + REFUSAL_RECONNECT_DELAY_MS,
        reportedReason: "handshake_stalled",
      });
    }
    socket.destroy();
  }

  private clearHelloTimer(): void {
    if (this.helloTimer) {
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
    }
  }

  private tellOperator(message: string): void {
    if (this.options.operatorMessage) {
      this.options.operatorMessage(message);
      return;
    }
    try {
      process.stderr.write(`nexus-agentd: ${message}\n`);
    } catch {
      // The durable log still contains the full operator guidance.
    }
  }

  private reasonKey(reason: unknown): string {
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }

  private async sendDetail(sessionId: string): Promise<void> {
    let messages: SessionMessage[];
    try {
      messages = await this.options.detailProvider(sessionId, DETAIL_MESSAGE_LIMIT);
    } catch (error) {
      if (!(error instanceof NotAttachedError)) {
        throw error;
      }
      if (this.openSessionId === sessionId) {
        this.openSessionId = undefined;
      }
      this.send({ type: "detail_rejected", sessionId, error: "not_attached" });
      return;
    }
    this.options.logger.info("phone_link_detail_read", {
      sessionId: sessionId.slice(0, 8),
      messages: messages.length,
    });
    if (this.openSessionId !== sessionId) {
      return;
    }
    const session = this.options.store.get(sessionId) ?? null;
    this.send({
      type: "detail",
      sessionId,
      // The phone routes a detail frame by provider; omitting it means Claude.
      provider: session?.provider ?? "claude",
      session,
      messages,
    });
  }

  private scheduleCodexDetailRefresh(session: Session): void {
    if (session.provider !== "codex" || this.openSessionId !== session.id) {
      return;
    }
    this.clearDetailRefreshTimer();
    this.detailRefreshTimer = setTimeout(() => {
      this.detailRefreshTimer = undefined;
      if (this.openSessionId === session.id) {
        this.queueDetailSend(session.id);
      }
    }, this.options.codexDetailRefreshDelayMs ?? CODEX_DETAIL_REFRESH_DELAY_MS);
    this.detailRefreshTimer.unref();
  }

  private queueDetailSend(sessionId: string): void {
    if (this.detailSendInFlight) {
      this.pendingDetailSessionId = sessionId;
      return;
    }
    const operation = this.sendDetail(sessionId);
    this.detailSendInFlight = operation;
    void operation
      .catch((error) => {
        this.options.logger.info("phone_link_detail_read_failed", {
          sessionId: sessionId.slice(0, 8),
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.detailSendInFlight !== operation) {
          return;
        }
        this.detailSendInFlight = undefined;
        const pendingSessionId = this.pendingDetailSessionId;
        this.pendingDetailSessionId = undefined;
        if (pendingSessionId && this.openSessionId === pendingSessionId) {
          this.queueDetailSend(pendingSessionId);
        }
      });
  }

  private clearDetailRefreshTimer(): void {
    if (this.detailRefreshTimer) {
      clearTimeout(this.detailRefreshTimer);
      this.detailRefreshTimer = undefined;
    }
  }

  private async sendFsListing(
    socket: TcpSocket,
    id: string,
    requestedPath: unknown,
  ): Promise<void> {
    let listing: FsListing;
    try {
      if (requestedPath === undefined || requestedPath === null) {
        listing = listRoots(platform(), homedir(), existsSync);
      } else if (typeof requestedPath === "string") {
        listing = await listDirectory(requestedPath, readdir);
      } else {
        listing = {
          path: null,
          parent: null,
          entries: [],
          truncated: false,
          error: "Path must be a local absolute path",
        };
      }
    } catch {
      listing = {
        path: typeof requestedPath === "string" ? requestedPath : null,
        parent: null,
        entries: [],
        truncated: false,
        error: "Unable to list directory",
      };
    }
    if (this.socket !== socket || socket.destroyed || !this.authenticated) {
      return;
    }
    this.send({ type: "fs_listing", id, ...listing });
  }

  private async sendThreadStarted(
    socket: TcpSocket,
    id: string,
    rawProvider: unknown,
    requestedPath: unknown,
    rawPrompt: unknown,
  ): Promise<void> {
    const provider: AgentProvider | undefined =
      rawProvider === "codex" || rawProvider === "claude" ? rawProvider : undefined;
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
    const promptLength = Buffer.byteLength(prompt, "utf8");
    let result: ThreadStartResult;

    if (!provider) {
      result = { ok: false, error: "Unknown provider" };
    } else if (typeof requestedPath !== "string") {
      result = { ok: false, error: "Path must be a local absolute path" };
    } else {
      const pathError = await validateExistingDirectory(requestedPath, stat);
      if (pathError) {
        result = { ok: false, error: pathError };
      } else if (typeof rawPrompt !== "string") {
        result = {
          ok: false,
          error: provider === "claude" ? "Prompt is required for Claude" : "Prompt must be a string",
        };
      } else if (promptLength > MAX_THREAD_PROMPT_BYTES) {
        result = { ok: false, error: "Prompt is too long" };
      } else if (provider === "claude" && !prompt) {
        result = { ok: false, error: "Prompt is required for Claude" };
      } else {
        result = await this.invokeThreadStart(provider, requestedPath, prompt);
      }
    }

    this.options.logger.info("phone_link_thread_start", {
      provider: provider ?? (typeof rawProvider === "string" ? rawProvider.slice(0, 16) : "unknown"),
      ok: result.ok,
      path: typeof requestedPath === "string" ? requestedPath.slice(0, 40) : "",
      promptLength,
    });
    if (this.socket !== socket || socket.destroyed || !this.authenticated) {
      return;
    }
    this.send({
      type: "thread_started",
      id,
      ok: result.ok,
      provider: provider ?? (typeof rawProvider === "string" ? rawProvider : null),
      ...(result.ok && result.sessionId ? { sessionId: result.sessionId } : {}),
      error: result.ok ? null : result.error ?? "Unable to start thread",
    });
  }

  private async sendTerminalInputResult(
    socket: TcpSocket,
    id: string,
    rawSessionId: unknown,
    rawText: unknown,
  ): Promise<void> {
    const sessionId = typeof rawSessionId === "string" ? rawSessionId : "";
    const outcome = this.options.onTerminalInput
      ? await this.options
          .onTerminalInput(sessionId, typeof rawText === "string" ? rawText : "")
          .catch(() => ({ ok: false, error: "Could not send that" }) as TerminalInputOutcome)
      : { ok: false, error: "Typing from the glasses is not available" };
    this.options.logger.info("phone_link_session_input", {
      sessionId: sessionId.slice(0, 16),
      ok: outcome.ok,
    });
    if (this.socket !== socket || socket.destroyed || !this.authenticated) {
      return;
    }
    this.send({
      type: "session_input_result",
      id,
      ok: outcome.ok,
      error: outcome.ok ? null : outcome.error ?? "Could not send that",
    });
  }

  private invokeThreadStart(
    provider: AgentProvider,
    requestedPath: string,
    prompt: string,
  ): Promise<ThreadStartResult> {
    const callback = this.options.onThreadStart;
    if (!callback) {
      return Promise.resolve({ ok: false, error: "Thread start is not available" });
    }
    return new Promise<ThreadStartResult>((resolve) => {
      let settled = false;
      const finish = (result: ThreadStartResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, error: "Timed out" }),
        Math.min(
          this.options.threadStartTimeoutMs ?? THREAD_START_TIMEOUT_MS,
          THREAD_START_TIMEOUT_MS,
        ),
      );
      timer.unref();
      void Promise.resolve()
        .then(() => callback(provider, requestedPath, prompt))
        .then(finish, (error) => finish({ ok: false, error: shortErrorMessage(error) }));
    });
  }

  private sendSnapshot(): void {
    const sessions = sessionsForPhone(this.options.store.list());
    this.publishedSessions = new Map(sessions.map((session) => [session.id, session]));
    this.lastUpserts.clear();
    const v2 = this.options.v2;
    this.send({
      type: "snapshot",
      ...(v2 ? { v: 2 } : {}),
      seq: this.sequence,
      sessions: v2 ? sessions.map((session) => v2.decorate(session)) : sessions,
    });
  }

  private reconcileSessions(changedSessionId: string): void {
    if (!this.authenticated) {
      return;
    }
    const sessions = sessionsForPhone(this.options.store.list());
    const next = new Map(sessions.map((session) => [session.id, session]));
    for (const sessionId of this.publishedSessions.keys()) {
      if (!next.has(sessionId)) {
        this.sendRemoved(sessionId);
      }
    }
    for (const session of sessions) {
      if (!this.publishedSessions.has(session.id) || session.id === changedSessionId) {
        this.sendUpsert(session);
      }
    }
    this.publishedSessions = next;
  }

  /** Hooks fire in bursts that change nothing the phone shows; an upsert identical to the last one sent is skipped. */
  private sendUpsert(session: Session): void {
    const v2 = this.options.v2;
    const published = v2 ? v2.decorate(session) : session;
    const payload = JSON.stringify(published);
    if (this.lastUpserts.get(session.id) === payload) {
      this.scheduleCodexDetailRefresh(session);
      return;
    }
    this.lastUpserts.set(session.id, payload);
    this.sequence += 1;
    this.send({
      type: "session_upsert",
      ...(v2 ? { v: 2 } : {}),
      seq: this.sequence,
      session: published,
    });
    this.scheduleCodexDetailRefresh(session);
  }

  private sendRemoved(sessionId: string): void {
    this.lastUpserts.delete(sessionId);
    this.sequence += 1;
    this.send({ type: "session_removed", seq: this.sequence, sessionId });
  }

  private send(message: Record<string, unknown>): boolean {
    if (!this.authenticated) {
      return false;
    }
    return this.write(message);
  }

  private write(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return false;
    }
    try {
      socket.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }
}

function shortErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 200);
  }
  return "Unable to start thread";
}

export function sessionsForPhone(sessions: Session[]): Session[] {
  const counts = new Map<Session["provider"], number>();
  return sessions.filter((session) => {
    const count = counts.get(session.provider) ?? 0;
    if (count >= MAX_PHONE_SESSIONS_PER_PROVIDER) {
      return false;
    }
    counts.set(session.provider, count + 1);
    return true;
  });
}
