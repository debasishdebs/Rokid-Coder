import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AttachChange, AttachRegistry } from "../attach-registry";
import { sessionKeyOf, type SessionKey } from "../protocol-v2";
import type { AgentProvider, Logger } from "../types";
import { findOwnedClaudeSession, isPidAlive } from "./claude-sessions";
import { LAUNCHER_SOCKET_NAME } from "./socket-name";

export { LAUNCHER_SOCKET_NAME };
export const HELLO_DEADLINE_MS = 5000;
/** Per line, excluding the newline. */
export const MAX_FRAME_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 1000;

export type TypeCommandKind = "compact" | "model" | "text";
export type CommandError =
  | "busy"
  | "timeout"
  | "dialog_not_seen"
  | "exited"
  | "not_ready"
  | "laptop_draft"
  | "cancelled"
  | "taken_over"
  | "uncertain";

export interface TypeCommand {
  cmdId: string;
  gen: number;
  notBefore?: number;
  command: TypeCommandKind;
  model?: string;
  text?: string;
}

/**
 * `too_long` is agentd's own: the command would not fit in one frame, so it
 * was never sent. It is a hard failure, never worth retrying.
 */
export type SendError = CommandError | "too_long";

export interface CommandResult {
  ok: boolean;
  error?: SendError;
}

export interface Binding {
  key: SessionKey;
  launcherId: string;
  gen: number;
  childPid: number;
  claudePid?: number;
  /** Set after a model command left the prompt in a state nobody saw (R141); commands are refused while it holds. */
  uncertain: boolean;
}

export interface LauncherHubOptions {
  configDir: string;
  claudeSessionsDir: string;
  logger: Logger;
  registry: AttachRegistry;
  /**
   * Opens the phone pairing window (allow-next). Only this socket, which is
   * same-user and 0600, may ask for it: the hook port is open to every local user.
   */
  armPairing?: () => void;
  /**
   * The pairing IPC for every computer-side client (`agentd pair`, `rk`'s
   * prompt, the installer): `pair_open` subscribes to `pair_status`, and
   * `pair_confirm` is the computer-side half of the SAS confirmation. Any
   * same-user process can send it, so it never pins on its own.
   */
  pairing?: PairingIpc;
  /**
   * A launcher has just bound this session. Claude's own SessionStart hook
   * normally arrives before the bind and is dropped as unattached, so this is
   * what lets the phone see the session before the first prompt.
   */
  onBound?: (session: { sessionId: string; status: string; cwd?: string }) => void;
}

export interface PairingIpc {
  /** Opens the window unless an attempt is running; both ways, the client is then told every change. */
  open(): void;
  watch(listener: (status: Record<string, unknown>) => void): () => void;
  confirm(attempt: unknown, ok: unknown): void;
}

const COMMAND_ERRORS: ReadonlySet<string> = new Set<CommandError>([
  "busy",
  "timeout",
  "dialog_not_seen",
  "exited",
  "not_ready",
  "laptop_draft",
  "cancelled",
  "taken_over",
  "uncertain",
]);
const LAUNCHER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,256}$/;
const CMD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PID = 0x7fffffff;

interface Hello {
  launcherId: string;
  provider: AgentProvider;
  childPid: number;
}

interface Pending {
  cmdId: string;
  resolve: (result: CommandResult) => void;
}

interface Connection {
  socket: net.Socket;
  buffer: Buffer;
  helloTimer?: NodeJS.Timeout;
  hello?: Hello;
  binding?: Binding;
  /** One command at a time per launcher; its result is taken only from this connection, once. */
  pending?: Pending;
  /** The last command sent here, still addressable after its result (a compact owns input until it is done). */
  lastCmdId?: string;
  /** R165: the command agentd last cancelled here; the launcher's own result for it still counts. */
  cancelledCmdId?: string;
  /** The session of the launcher's last `launcher_bind`, so it can be asked again when a refusal ends. */
  lastBind?: { sessionId: string };
  /** N2: the session this launcher was asked to bind again, and who waits for its answer. */
  asked?: { key: SessionKey; waiters: Array<(bound: boolean) => void> };
  /** Set while this connection is a pairing client: stops its `pair_status` feed. */
  pairingWatch?: () => void;
  draft: boolean;
  closed: boolean;
}

type Frame = Record<string, unknown>;

/** Exactly these keys: the required ones, plus any of the optional ones. */
function hasShape(frame: Frame, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(frame);
  return (
    required.every((key) => Object.hasOwn(frame, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isChildPid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 1 && (value as number) <= MAX_PID;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.name : "unknown");
}

function lstatOrUndefined(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * The `rk` launchers' socket (R52) and the bindings it proves (R49). A
 * launcher binds a Claude session only by showing that Claude wrote the
 * session's file for a process in the launcher's own pty child's tree; hooks
 * never bind (R48). Launcher mode exists only while the binding is live.
 */
export class LauncherHub {
  readonly socketPath: string;
  private readonly options: LauncherHubOptions;
  private server?: net.Server;
  private readonly connections = new Set<Connection>();
  private readonly byLauncherId = new Map<string, Connection>();
  private readonly byKey = new Map<SessionKey, Connection>();
  private readonly listeners: Array<(key: SessionKey) => void> = [];
  private readonly writtenListeners: Array<(key: SessionKey, cmdId: string, at: number) => void> = [];
  private readonly lateResultListeners: Array<(cmdId: string, ok: boolean) => void> = [];
  /** Why each key's last binding ended: `exited` when its launcher went away, `cancelled` when it moved on. */
  private readonly unbound = new Map<SessionKey, CommandError>();
  private generation = 0;
  /** Set while a bind runs: the registry change a bind itself makes must not start another. */
  private bindRunning = false;
  private stopListening?: () => void;

  constructor(options: LauncherHubOptions) {
    this.options = options;
    this.socketPath = path.join(options.configDir, LAUNCHER_SOCKET_NAME);
  }

  get enabled(): boolean {
    return this.server !== undefined;
  }

  /** Never rejects: any check that fails leaves agentd running without launchers. */
  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    const problem = this.checkConfigDir() ?? await this.clearSocketPath();
    if (problem) {
      this.disable(problem);
      return;
    }
    const server = net.createServer((socket) => this.accept(socket));
    const listenError = await new Promise<string | undefined>((resolve) => {
      server.once("error", (error) => resolve(errorCode(error)));
      server.listen(this.socketPath, () => resolve(undefined));
    });
    if (listenError) {
      this.disable(`listen failed (${listenError})`);
      return;
    }
    try {
      chmodSync(this.socketPath, 0o600);
    } catch (error) {
      server.close();
      this.disable(`could not chmod the socket (${errorCode(error)})`);
      return;
    }
    server.on("error", (error) => this.options.logger.warn("launcher_socket_error", { reason: errorCode(error) }));
    this.server = server;
    this.stopListening = this.options.registry.onChange((change) => this.onRegistryChange(change));
  }

  async stop(): Promise<void> {
    this.stopListening?.();
    this.stopListening = undefined;
    for (const connection of [...this.connections]) {
      connection.socket.destroy();
      this.onClose(connection);
    }
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Live bindings only. */
  binding(key: SessionKey): Binding | undefined {
    const binding = this.byKey.get(key)?.binding;
    return binding ? { ...binding } : undefined;
  }

  /** Bound sessions, for whoever has to look at each in turn. */
  boundKeys(): SessionKey[] {
    return [...this.byKey.keys()];
  }

  /** `cmdId` lets the caller tie the launcher's later frames to this command; it is made up here otherwise. */
  send(key: SessionKey, cmd: Omit<TypeCommand, "cmdId" | "gen"> & { cmdId?: string }): Promise<CommandResult> {
    const connection = this.byKey.get(key);
    const binding = connection?.binding;
    if (!connection || !binding || connection.closed) {
      return Promise.resolve({ ok: false, error: "exited" });
    }
    if (connection.pending) {
      return Promise.resolve({ ok: false, error: "busy" });
    }
    // R141: nothing is typed into a prompt whose state is not known.
    if (binding.uncertain) {
      return Promise.resolve({ ok: false, error: "uncertain" });
    }
    const frame: TypeCommand & { type: "type_command" } = {
      type: "type_command",
      cmdId: cmd.cmdId ?? randomUUID(),
      gen: binding.gen,
      ...(cmd.notBefore !== undefined ? { notBefore: cmd.notBefore } : {}),
      command: cmd.command,
      ...(cmd.model !== undefined ? { model: cmd.model } : {}),
      ...(cmd.text !== undefined ? { text: cmd.text } : {}),
    };
    // Frames are bounded both ways; the launcher would drop an overlong one.
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
      return Promise.resolve({ ok: false, error: "too_long" });
    }
    return new Promise((resolve) => {
      connection.pending = { cmdId: frame.cmdId, resolve };
      connection.lastCmdId = frame.cmdId;
      this.write(connection, frame);
    });
  }

  cancel(key: SessionKey, reason: "cancelled" | "taken_over"): void {
    const connection = this.byKey.get(key);
    if (connection) {
      this.settlePending(connection, reason, true);
    }
  }

  /**
   * R148: agentd has given up on a command the launcher may still be running
   * (a compact past its ok owns input until compact_done). The cancel goes to
   * the connection that received `cmdId`, bound to that session or not.
   */
  cancelCommand(cmdId: string): void {
    for (const connection of this.connections) {
      if (connection.closed || connection.lastCmdId !== cmdId) {
        continue;
      }
      connection.lastCmdId = undefined;
      if (connection.pending?.cmdId === cmdId) {
        this.settlePending(connection, "cancelled", true);
      } else {
        this.write(connection, { type: "cancel_command", cmdId });
      }
    }
  }

  /** R149: Claude took a prompt in this session; the launcher may clear a draft it was holding on to. */
  promptSubmitted(key: SessionKey, at: number): void {
    const connection = this.byKey.get(key);
    if (connection?.binding) {
      this.write(connection, { type: "prompt_submitted", at });
    }
  }

  /** A compact this launcher typed has really finished (Task 4 saw its PostCompact). */
  compactDone(key: SessionKey, cmdId: string): void {
    const connection = this.byKey.get(key);
    if (connection?.binding) {
      this.write(connection, { type: "compact_done", cmdId });
    }
  }

  /** What a command still waiting on a key that is no longer bound fails with. */
  unboundReason(key: SessionKey): CommandError | undefined {
    return this.byKey.has(key) ? undefined : this.unbound.get(key);
  }

  laptopDraft(key: SessionKey): boolean {
    return this.byKey.get(key)?.draft === true;
  }

  /** Task 4 sets this; the launcher is told on every change. */
  setUncertain(key: SessionKey, uncertain: boolean): void {
    const connection = this.byKey.get(key);
    const binding = connection?.binding;
    if (!connection || !binding || binding.uncertain === uncertain) {
      return;
    }
    binding.uncertain = uncertain;
    this.write(connection, { type: "binding_state", gen: binding.gen, uncertain });
    this.emit(key);
  }

  onChange(cb: (key: SessionKey) => void): void {
    this.listeners.push(cb);
  }

  /** R165: the launcher's own result for a command agentd had already cancelled on its connection. */
  onLateResult(cb: (cmdId: string, ok: boolean) => void): void {
    this.lateResultListeners.push(cb);
  }

  /** A launcher wrote a command's first bytes into its session's prompt. */
  onCommandWritten(cb: (key: SessionKey, cmdId: string, at: number) => void): void {
    this.writtenListeners.push(cb);
  }

  private disable(reason: string): void {
    this.options.logger.warn(`launcher socket disabled: ${reason}`);
  }

  /**
   * The config dir must be a real directory of ours, mode 0700; it is created
   * so when absent. One of ours that is looser is tightened (R134): it is our
   * own private dir, and launchers silently off would be worse.
   */
  private checkConfigDir(): string | undefined {
    const dir = this.options.configDir;
    let stats: Stats | undefined;
    try {
      stats = lstatOrUndefined(dir);
      if (!stats) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        stats = lstatSync(dir);
      }
    } catch (error) {
      return `config dir unusable (${errorCode(error)})`;
    }
    if (stats.isSymbolicLink()) {
      return "config dir is a symlink";
    }
    if (!stats.isDirectory()) {
      return "config dir is not a directory";
    }
    // Every later check and the chmod go through this fd, so the path cannot
    // be swapped for a symlink or another directory in between.
    let fd: number;
    try {
      fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      const code = errorCode(error);
      return code === "ELOOP" ? "config dir is a symlink" : code === "ENOTDIR" ? "config dir is not a directory" : `config dir unusable (${code})`;
    }
    try {
      return this.checkOpenConfigDir(fd);
    } finally {
      closeSync(fd);
    }
  }

  private checkOpenConfigDir(fd: number): string | undefined {
    let stats: Stats;
    try {
      stats = fstatSync(fd);
    } catch (error) {
      return `config dir unusable (${errorCode(error)})`;
    }
    if (!stats.isDirectory()) {
      return "config dir is not a directory";
    }
    if (stats.uid !== process.getuid?.()) {
      return "config dir is not owned by this user";
    }
    let mode = stats.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      try {
        fchmodSync(fd, 0o700);
        mode = fstatSync(fd).mode & 0o777;
      } catch (error) {
        return `could not tighten the config dir (${errorCode(error)})`;
      }
      this.options.logger.warn("launcher socket dir permissions tightened to 0700");
    }
    if (mode !== 0o700) {
      return `config dir mode is ${mode.toString(8).padStart(4, "0")}, not 0700`;
    }
    return undefined;
  }

  /** Leaves the path free to listen on, or says why it cannot be. */
  private async clearSocketPath(): Promise<string | undefined> {
    let stats: Stats | undefined;
    try {
      stats = lstatOrUndefined(this.socketPath);
    } catch (error) {
      return `socket path unreadable (${errorCode(error)})`;
    }
    if (!stats) {
      return undefined;
    }
    if (!stats.isSocket() || stats.uid !== process.getuid?.()) {
      return "socket path holds something that is not our socket";
    }
    const probe = await this.probe();
    if (probe === "live") {
      return "another agentd is listening";
    }
    if (probe === "gone") {
      return undefined;
    }
    if (probe !== "stale") {
      return `socket probe failed (${probe})`;
    }
    try {
      unlinkSync(this.socketPath);
    } catch (error) {
      return `could not remove the stale socket (${errorCode(error)})`;
    }
    return undefined;
  }

  private probe(): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve("timeout");
      }, PROBE_TIMEOUT_MS);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve("live");
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        const code = errorCode(error);
        resolve(code === "ECONNREFUSED" ? "stale" : code === "ENOENT" ? "gone" : code);
      });
    });
  }

  private accept(socket: net.Socket): void {
    const connection: Connection = { socket, buffer: Buffer.alloc(0), draft: false, closed: false };
    this.connections.add(connection);
    connection.helloTimer = setTimeout(() => this.drop(connection, "hello_timeout"), HELLO_DEADLINE_MS);
    socket.on("data", (chunk: Buffer) => this.onData(connection, chunk));
    socket.on("close", () => this.onClose(connection));
    socket.on("error", () => socket.destroy());
  }

  private onData(connection: Connection, chunk: Buffer): void {
    const buffer = connection.buffer.length > 0 ? Buffer.concat([connection.buffer, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline < 0) {
        break;
      }
      if (newline - start > MAX_FRAME_BYTES) {
        this.drop(connection, "frame_too_long");
        return;
      }
      const line = buffer.toString("utf8", start, newline);
      start = newline + 1;
      const violation = this.handleLine(connection, line);
      if (violation) {
        this.drop(connection, violation);
        return;
      }
      if (connection.closed) {
        return;
      }
    }
    connection.buffer = Buffer.from(buffer.subarray(start));
    if (connection.buffer.length > MAX_FRAME_BYTES) {
      this.drop(connection, "frame_too_long");
    }
  }

  /** Returns why the connection must close, or undefined when the frame was fine. */
  private handleLine(connection: Connection, line: string): string | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return "bad_json";
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "bad_frame";
    }
    const frame = parsed as Frame;
    if (!connection.hello) {
      if (frame.type === "arm_pairing") {
        return this.onArmPairing(connection, frame);
      }
      if (frame.type === "pair_open") {
        return this.onPairOpen(connection, frame);
      }
      if (frame.type === "pair_confirm") {
        if (!hasShape(frame, ["type", "attempt", "ok"]) || !this.options.pairing) {
          return "bad_frame";
        }
        this.options.pairing.confirm(frame.attempt, frame.ok);
        return undefined;
      }
      return frame.type === "launcher_hello" ? this.onHello(connection, frame) : "hello_expected";
    }
    switch (frame.type) {
      case "launcher_bind":
        if (
          !hasShape(frame, ["type", "sessionId"], ["uncertain"]) ||
          typeof frame.sessionId !== "string" ||
          !SESSION_ID.test(frame.sessionId) ||
          (frame.uncertain !== undefined && typeof frame.uncertain !== "boolean")
        ) {
          return "bad_frame";
        }
        connection.lastBind = { sessionId: frame.sessionId };
        this.onBind(connection, frame.sessionId, frame.uncertain === true);
        this.answerAsked(connection);
        return undefined;
      case "command_result": {
        if (
          !hasShape(frame, ["type", "cmdId", "ok"], ["error"]) ||
          typeof frame.cmdId !== "string" ||
          !CMD_ID.test(frame.cmdId) ||
          typeof frame.ok !== "boolean" ||
          (frame.ok ? frame.error !== undefined : typeof frame.error !== "string" || !COMMAND_ERRORS.has(frame.error))
        ) {
          return "bad_frame";
        }
        const pending = connection.pending;
        if (pending?.cmdId === frame.cmdId) {
          connection.pending = undefined;
          pending.resolve(frame.ok ? { ok: true } : { ok: false, error: frame.error as CommandError });
        } else if (connection.cancelledCmdId === frame.cmdId) {
          connection.cancelledCmdId = undefined;
          this.emitLateResult(frame.cmdId, frame.ok);
        }
        return undefined;
      }
      case "command_written":
        if (
          !hasShape(frame, ["type", "cmdId", "at"]) ||
          typeof frame.cmdId !== "string" ||
          !CMD_ID.test(frame.cmdId) ||
          typeof frame.at !== "number" ||
          !Number.isFinite(frame.at)
        ) {
          return "bad_frame";
        }
        // Any write counts, even one for a command already settled here: the
        // prompt was typed into either way.
        if (connection.binding) {
          this.emitWritten(connection.binding.key, frame.cmdId, frame.at);
        }
        return undefined;
      case "laptop_state":
        if (!hasShape(frame, ["type", "draft"]) || typeof frame.draft !== "boolean") {
          return "bad_frame";
        }
        if (connection.draft !== frame.draft) {
          connection.draft = frame.draft;
          if (connection.binding) {
            this.emit(connection.binding.key);
          }
        }
        return undefined;
      case "launcher_hello":
        return "duplicate_hello";
      default:
        // R133 (Task 0 spike, Path B): `rk codex` cannot create a thread it
        // owns, so there is no codex_thread_start frame; it is an unknown type.
        return "unknown_type";
    }
  }

  private onHello(connection: Connection, frame: Frame): string | undefined {
    if (
      !hasShape(frame, ["type", "v", "launcherId", "provider", "childPid"]) ||
      frame.v !== 1 ||
      typeof frame.launcherId !== "string" ||
      !LAUNCHER_ID.test(frame.launcherId) ||
      (frame.provider !== "claude" && frame.provider !== "codex") ||
      !isChildPid(frame.childPid)
    ) {
      return "bad_hello";
    }
    const holder = this.byLauncherId.get(frame.launcherId);
    if (holder && !holder.closed) {
      return "duplicate_launcher_id";
    }
    clearTimeout(connection.helloTimer);
    connection.helloTimer = undefined;
    connection.hello = { launcherId: frame.launcherId, provider: frame.provider, childPid: frame.childPid };
    this.byLauncherId.set(frame.launcherId, connection);
    return undefined;
  }

  /**
   * R49. Every check runs before anything changes; a refusal changes nothing,
   * except that a refused launcher adopts an unadopted explicit detach.
   *
   * `childPid` is the launcher's own claim from its hello: Node cannot tell
   * which process is on the other end of a Unix socket, so the descendant
   * check proves the session belongs to that pid's tree, not that the peer
   * spawned it. Any process of this user could name some claude's pid. That
   * is acceptable under R48, which trusts the user's own processes; the
   * socket's 0700 dir and 0600 mode keep other users out.
   */
  /** `uncertain` is the launcher's own (R161): a binding never starts more certain than its launcher is. */
  private onBind(connection: Connection, sessionId: string, uncertain: boolean): void {
    this.bindRunning = true;
    try {
      this.bind(connection, sessionId, uncertain);
    } finally {
      this.bindRunning = false;
    }
  }

  private bind(connection: Connection, sessionId: string, uncertain: boolean): void {
    const hello = connection.hello as Hello;
    const reject = (reason: string): void => {
      this.options.logger.info("launcher_bind_rejected", { reason });
      this.write(connection, { type: "bind_rejected", reason });
    };
    // R133: Codex sessions are never launcher-bound. The Task 0 spike found no
    // way for `rk codex` to create a thread it owns (Path B), so there is
    // nothing a Codex launcher could prove ownership with.
    if (hello.provider !== "claude") {
      reject("unsupported");
      return;
    }
    const key = sessionKeyOf("claude", sessionId);
    const current = connection.binding;
    if (current?.key === key) {
      this.write(connection, { type: "bind_accepted", gen: current.gen });
      if (uncertain) {
        this.setUncertain(key, true);
      }
      return;
    }
    if (!isPidAlive(hello.childPid)) {
      reject("child_exited");
      return;
    }
    const owner = this.byKey.get(key);
    if (owner && owner !== connection) {
      reject("owned");
      return;
    }
    const session = findOwnedClaudeSession(this.options.claudeSessionsDir, hello.childPid);
    if (!session || session.sessionId !== sessionId) {
      reject("not_owned");
      return;
    }
    // Last, so only the launcher that really runs the session can adopt an
    // explicit detach made while no launcher held it.
    const detached = this.options.registry.explicitDetach(key);
    if (detached) {
      if (detached.childPid === undefined) {
        this.options.registry.recordExplicitDetach({ key, launcherId: hello.launcherId, childPid: hello.childPid });
        reject("detached");
        return;
      }
      if (isPidAlive(detached.childPid)) {
        reject("detached");
        return;
      }
      this.options.registry.dropExplicitDetach(key);
    }
    try {
      this.options.registry.attach("claude", sessionId, "launcher");
    } catch (error) {
      this.options.logger.error("launcher_bind_persist_failed", { reason: errorCode(error) });
      reject("persist_failed");
      return;
    }
    // A new session from the same launcher (/clear, a resume) retires the old one.
    if (current) {
      this.unbind(connection, { error: "cancelled", notify: true, demote: true });
    }
    this.generation += 1;
    const binding: Binding = {
      key,
      launcherId: hello.launcherId,
      gen: this.generation,
      childPid: hello.childPid,
      claudePid: session.pid,
      uncertain,
    };
    connection.binding = binding;
    this.byKey.set(key, connection);
    this.unbound.delete(key);
    this.options.logger.info("launcher_bound", { gen: binding.gen });
    this.write(connection, { type: "bind_accepted", gen: binding.gen });
    this.write(connection, { type: "binding_state", gen: binding.gen, uncertain });
    this.emit(key);
    this.options.onBound?.({ sessionId, status: session.status, ...(session.cwd ? { cwd: session.cwd } : {}) });
  }

  /**
   * `/rokid:off` of a bound session is an explicit detach by this launcher
   * (R51). The registry has already saved one keyed on the session; this adds
   * the launcher's identity.
   */
  private onRegistryChange({ kind, entry }: AttachChange): void {
    const key = sessionKeyOf(entry.provider, entry.id);
    if (kind === "attached") {
      this.retryRefusedBinds(key);
      return;
    }
    const connection = this.byKey.get(key);
    if (!connection?.binding || !connection.hello) {
      return;
    }
    this.options.registry.recordExplicitDetach({
      key,
      launcherId: connection.hello.launcherId,
      childPid: connection.hello.childPid,
    });
    this.unbind(connection, { error: "cancelled", notify: true, demote: false });
    // The launcher learns it is no longer bound, so it may ask again after /rokid:on.
    this.write(connection, { type: "bind_rejected", reason: "detached" });
  }

  /**
   * `/rokid:on` ended an explicit detach: a launcher still asking for that
   * session is asked to bind now rather than at its next retry. N2: it binds
   * with a fresh `launcher_bind`, since only the launcher knows whether it is
   * still uncertain; its refused ask may be 30 s old.
   */
  private retryRefusedBinds(key: SessionKey): void {
    if (this.bindRunning || this.byKey.has(key)) {
      return;
    }
    for (const connection of [...this.connections]) {
      const last = connection.lastBind;
      if (!connection.closed && !connection.binding && connection.hello && last && sessionKeyOf("claude", last.sessionId) === key) {
        connection.asked ??= { key, waiters: [] };
        this.write(connection, { type: "bind_retry" });
        return;
      }
    }
  }

  /**
   * M9 with N2: when a launcher was just asked to bind `key` again, resolves
   * once it has answered, true when that bound it, or false after `ms`.
   * Undefined when no launcher was asked.
   */
  rebound(key: SessionKey, ms: number): Promise<boolean> | undefined {
    const connection = [...this.connections].find((c) => !c.closed && c.asked?.key === key);
    const asked = connection?.asked;
    if (!asked) {
      return undefined;
    }
    return new Promise((resolve) => {
      const done = (bound: boolean): void => {
        clearTimeout(timer);
        resolve(bound);
      };
      const timer = setTimeout(() => done(false), ms);
      asked.waiters.push(done);
    });
  }

  private answerAsked(connection: Connection): void {
    const asked = connection.asked;
    if (!asked) {
      return;
    }
    connection.asked = undefined;
    const bound = connection.binding?.key === asked.key;
    for (const done of asked.waiters) {
      done(bound);
    }
  }

  private unbind(
    connection: Connection,
    options: { error: CommandError; notify: boolean; demote: boolean },
  ): void {
    const binding = connection.binding;
    if (!binding) {
      return;
    }
    connection.binding = undefined;
    if (this.byKey.get(binding.key) === connection) {
      this.byKey.delete(binding.key);
      this.unbound.set(binding.key, options.error);
    }
    this.settlePending(connection, options.error, options.notify);
    if (options.demote) {
      const id = binding.key.slice("claude:".length);
      if (this.options.registry.mode("claude", id) === "launcher") {
        try {
          this.options.registry.attach("claude", id, "plugin");
        } catch (error) {
          // Startup rewrites it to plugin anyway.
          this.options.logger.error("launcher_unbind_persist_failed", { reason: errorCode(error) });
        }
      }
    }
    this.emit(binding.key);
  }

  private settlePending(connection: Connection, error: CommandError, notify: boolean): void {
    const pending = connection.pending;
    if (!pending) {
      return;
    }
    connection.pending = undefined;
    connection.cancelledCmdId = pending.cmdId;
    if (notify) {
      this.write(connection, { type: "cancel_command", cmdId: pending.cmdId });
    }
    pending.resolve({ ok: false, error });
  }

  private drop(connection: Connection, reason: string): void {
    if (connection.closed) {
      return;
    }
    this.options.logger.warn("launcher_connection_dropped", { reason });
    connection.socket.destroy();
    this.onClose(connection);
  }

  /** A one-shot request: no hello, one answer, then the connection closes. */
  private onArmPairing(connection: Connection, frame: Frame): string | undefined {
    if (!hasShape(frame, ["type"])) {
      return "bad_frame";
    }
    let ok = false;
    try {
      this.options.armPairing?.();
      ok = this.options.armPairing !== undefined;
    } catch (error) {
      this.options.logger.error("arm_pairing_failed", { reason: errorCode(error) });
    }
    this.write(connection, { type: "pairing_armed", ok });
    connection.socket.end();
    this.onClose(connection);
    return undefined;
  }

  /** A pairing client: no hello, the window opened (or joined), then every status until it hangs up. */
  private onPairOpen(connection: Connection, frame: Frame): string | undefined {
    const pairing = this.options.pairing;
    if (!hasShape(frame, ["type"]) || !pairing) {
      return "bad_frame";
    }
    clearTimeout(connection.helloTimer);
    // A client already watching may open the next window after the last one ended.
    connection.pairingWatch ??= pairing.watch((status) => this.write(connection, { type: "pair_status", ...status }));
    try {
      pairing.open();
    } catch (error) {
      this.options.logger.error("pair_open_failed", { reason: errorCode(error) });
      this.write(connection, { type: "pair_status", state: "ABORTED", reason: "storage" });
    }
    return undefined;
  }

  private onClose(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    connection.pairingWatch?.();
    connection.pairingWatch = undefined;
    clearTimeout(connection.helloTimer);
    this.connections.delete(connection);
    if (connection.hello && this.byLauncherId.get(connection.hello.launcherId) === connection) {
      this.byLauncherId.delete(connection.hello.launcherId);
    }
    this.unbind(connection, { error: "exited", notify: false, demote: true });
    this.answerAsked(connection);
  }

  private write(connection: Connection, frame: object): void {
    if (!connection.closed && connection.socket.writable) {
      connection.socket.write(`${JSON.stringify(frame)}\n`);
    }
  }

  private emitLateResult(cmdId: string, ok: boolean): void {
    for (const listener of [...this.lateResultListeners]) {
      try {
        listener(cmdId, ok);
      } catch (error) {
        this.options.logger.error("launcher_listener_failed", { reason: errorCode(error) });
      }
    }
  }

  private emitWritten(key: SessionKey, cmdId: string, at: number): void {
    for (const listener of [...this.writtenListeners]) {
      try {
        listener(key, cmdId, at);
      } catch (error) {
        this.options.logger.error("launcher_listener_failed", { reason: errorCode(error) });
      }
    }
  }

  private emit(key: SessionKey): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(key);
      } catch (error) {
        this.options.logger.error("launcher_listener_failed", { reason: errorCode(error) });
      }
    }
  }
}
