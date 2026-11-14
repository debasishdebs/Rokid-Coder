import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync, type Stats } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AttachChange, AttachRegistry } from "../attach-registry";
import { sessionKeyOf, type SessionKey } from "../protocol-v2";
import type { AgentProvider, Logger } from "../types";
import { findOwnedClaudeSession, isPidAlive } from "./claude-sessions";

export const LAUNCHER_SOCKET_NAME = "launcher.sock";
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

export interface CommandResult {
  ok: boolean;
  error?: CommandError;
}

export interface Binding {
  key: SessionKey;
  launcherId: string;
  gen: number;
  childPid: number;
  claudePid?: number;
  /** Task 4: set after a failed model recovery; commands are refused while it holds. */
  uncertain: boolean;
}

export interface LauncherHubOptions {
  configDir: string;
  claudeSessionsDir: string;
  logger: Logger;
  registry: AttachRegistry;
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
  private generation = 0;
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

  send(key: SessionKey, cmd: Omit<TypeCommand, "cmdId" | "gen">): Promise<CommandResult> {
    const connection = this.byKey.get(key);
    const binding = connection?.binding;
    if (!connection || !binding || connection.closed) {
      return Promise.resolve({ ok: false, error: "exited" });
    }
    if (connection.pending) {
      return Promise.resolve({ ok: false, error: "busy" });
    }
    const frame: TypeCommand & { type: "type_command" } = {
      type: "type_command",
      cmdId: randomUUID(),
      gen: binding.gen,
      ...(cmd.notBefore !== undefined ? { notBefore: cmd.notBefore } : {}),
      command: cmd.command,
      ...(cmd.model !== undefined ? { model: cmd.model } : {}),
      ...(cmd.text !== undefined ? { text: cmd.text } : {}),
    };
    // Frames are bounded both ways; the launcher would drop an overlong one.
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
      return Promise.resolve({ ok: false, error: "not_ready" });
    }
    return new Promise((resolve) => {
      connection.pending = { cmdId: frame.cmdId, resolve };
      this.write(connection, frame);
    });
  }

  cancel(key: SessionKey, reason: "cancelled" | "taken_over"): void {
    const connection = this.byKey.get(key);
    if (connection) {
      this.settlePending(connection, reason, true);
    }
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

  private disable(reason: string): void {
    this.options.logger.warn(`launcher socket disabled: ${reason}`);
  }

  /** The config dir must be a real directory of ours, mode 0700; it is created so when absent. */
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
    if (stats.uid !== process.getuid?.()) {
      return "config dir is not owned by this user";
    }
    const mode = stats.mode & 0o777;
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
      return frame.type === "launcher_hello" ? this.onHello(connection, frame) : "hello_expected";
    }
    switch (frame.type) {
      case "launcher_bind":
        if (!hasShape(frame, ["type", "sessionId"]) || typeof frame.sessionId !== "string" || !SESSION_ID.test(frame.sessionId)) {
          return "bad_frame";
        }
        this.onBind(connection, frame.sessionId);
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
        }
        return undefined;
      }
      case "command_written":
        // Task 4 latches the session on this; for now it only has to be well formed.
        if (
          !hasShape(frame, ["type", "cmdId", "at"]) ||
          typeof frame.cmdId !== "string" ||
          !CMD_ID.test(frame.cmdId) ||
          typeof frame.at !== "number" ||
          !Number.isFinite(frame.at)
        ) {
          return "bad_frame";
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

  /** R49. Every check runs before anything changes; a refusal changes nothing. */
  private onBind(connection: Connection, sessionId: string): void {
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
      return;
    }
    if (!isPidAlive(hello.childPid)) {
      reject("child_exited");
      return;
    }
    const detached = this.options.registry.explicitDetach(key);
    if (detached) {
      if (isPidAlive(detached.childPid)) {
        reject("detached");
        return;
      }
      this.options.registry.dropExplicitDetach(key);
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
      uncertain: false,
    };
    connection.binding = binding;
    this.byKey.set(key, connection);
    this.options.logger.info("launcher_bound", { gen: binding.gen });
    this.write(connection, { type: "bind_accepted", gen: binding.gen });
    this.write(connection, { type: "binding_state", gen: binding.gen, uncertain: false });
    this.emit(key);
  }

  /** `/rokid:off` (or any detach) of a bound session is an explicit detach (R51). */
  private onRegistryChange({ kind, entry }: AttachChange): void {
    if (kind !== "detached") {
      return;
    }
    const key = sessionKeyOf(entry.provider, entry.id);
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

  private onClose(connection: Connection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    clearTimeout(connection.helloTimer);
    this.connections.delete(connection);
    if (connection.hello && this.byLauncherId.get(connection.hello.launcherId) === connection) {
      this.byLauncherId.delete(connection.hello.launcherId);
    }
    this.unbind(connection, { error: "exited", notify: false, demote: true });
  }

  private write(connection: Connection, frame: object): void {
    if (!connection.closed && connection.socket.writable) {
      connection.socket.write(`${JSON.stringify(frame)}\n`);
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
