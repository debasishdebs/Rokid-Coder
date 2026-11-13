"use strict";
/**
 * Fake phone for agentd tests, usable against both phone transports:
 *
 *   "phonelink"  the fake LISTENS on TCP (newline-delimited JSON) and agentd's
 *                PhoneLink dials it, as a real phone does.
 *   "wshub"      the fake CONNECTS to agentd's WsHub over WebSocket.
 *
 * `tls: true` makes the link real TLS, the way a phone does it:
 *   phonelink  the fake is the TLS server, with its own self-signed cert
 *              (`phone.fingerprint`, or pass `cert: { key, cert }`). agentd pins
 *              that cert on the first authenticated hello.
 *   wshub      the fake connects over wss and checks agentd's cert against `pin`
 *              (agentd's sha256 fingerprint, as in the pairing payload) before
 *              it sends a token; a mismatch rejects `start()`. To steer it must
 *              also send `steer` (the pairing payload's secret) in its hello.
 * Without it the link is plaintext, which agentd treats as monitor-only.
 *
 * Also runnable as a CLI that pairs, prints every received frame as a JSON line
 * and sends the frame named after the flags:
 *   node test/fake-phone.js --transport phonelink [--port 8792] [--token T] followup claude:ID "text"
 *   node test/fake-phone.js --transport wshub --port 8792 --token T mode_set claude:ID acceptEdits
 * `--wait MS` exits after MS; otherwise it stays up until SIGINT. A real agentd
 * accepts steering frames only over TLS: add `--tls true` (wshub also needs
 * `--pin <agentd fingerprint>` and the secret in the FAKE_PHONE_STEER environment
 * variable or in a file named by `--steer-file`, never on argv, where `ps` shows it); over plaintext they come back
 * `ack rejected monitor_only`.
 */
const net = require("node:net");
const tlsModule = require("node:tls");
const WebSocket = require("ws");
const { normalizeFingerprint } = require("../dist/tls.js");
const { phoneCert } = require("./helpers/tls.js");

const DEFAULT_TIMEOUT_MS = 2000;

let nextMsgId = 0;
const newMsgId = () => `fake-${process.pid}-${Date.now().toString(36)}-${nextMsgId++}`;

const DEFAULT_TIMINGS = {
  ageBoostMs: 30000,
  dwellMs: 8000,
  ackTimeoutMs: 5000,
  retryBackoffMs: [5000, 10000, 20000],
  reminderMs: 300000,
  expireMs: 1800000,
};

/**
 * The v2 phone -> agent frames, built from positional arguments the way the CLI
 * takes them. Steering frames get a fresh msgId; pass `{ msgId }` to reuse one.
 */
const FRAME_BUILDERS = {
  followup: ([sessionKey, text]) => ({ sessionKey, text }),
  question_answer: ([sessionKey, alertId, requestRef, answers]) =>
    ({ sessionKey, alertId, requestRef, answers: JSON.parse(answers) }),
  mode_set: ([sessionKey, mode, confirmed]) => ({ sessionKey, mode, confirmed: confirmed === "true" }),
  mode_revoke_all: () => ({}),
  codex_settings: ([sessionKey, model, effort]) =>
    ({ sessionKey, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }),
  codex_compact: ([sessionKey]) => ({ sessionKey }),
  alert_action: ([id, action]) => ({ id, action }),
  alert_shown: ([id]) => ({ id }),
  alert_dismissed: ([id]) => ({ id }),
  defaults_set: ([claude, codex]) => ({ defaultModes: { claude, codex } }),
  settings_sync: ([waitLimitMs]) => ({ timings: DEFAULT_TIMINGS, waitLimitMs: Number(waitLimitMs) }),
  models_request: ([sessionKey]) => ({ sessionKey }),
  // Any frame at all, steering or not, for the cases the builders do not cover.
  raw: ([json]) => JSON.parse(json),
};
const MONITOR_ONLY_BUILDERS = new Set(["alert_shown", "alert_dismissed", "models_request", "raw"]);

function buildFrame(type, args = [], { msgId } = {}) {
  const build = FRAME_BUILDERS[type];
  if (!build) throw new Error(`unknown frame "${type}" (known: ${Object.keys(FRAME_BUILDERS).join(", ")})`);
  const fields = build(args);
  const frame = type === "raw" ? fields : { type, v: 2, ...fields };
  if (!MONITOR_ONLY_BUILDERS.has(type) && frame.msgId === undefined) {
    frame.msgId = msgId ?? newMsgId();
  }
  return frame;
}

function createFakePhone({ transport, tls = false, pin, cert, steer, onFrame } = {}) {
  if (transport !== "phonelink" && transport !== "wshub") {
    throw new Error(`unknown fake phone transport: ${transport}`);
  }

  const frames = [];
  let waiters = [];
  let writeFrame = null;
  let closeTransport = () => {};
  let started = false;
  let closeWaiters = [];

  function noteClosed() {
    phone.closes += 1;
    const ready = closeWaiters.splice(0);
    ready.forEach((fn) => fn());
  }

  function record(frame) {
    frames.push(frame);
    if (onFrame) onFrame(frame);
    waiters = waiters.filter((waiter) => !waiter(frame));
    // An app-level ping must be answered or agentd drops the link as dead.
    if (frame && frame.type === "ping") {
      phone.send({ type: "pong", t: frame.t });
    }
  }

  function parse(text) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  const phone = {
    transport,
    tls,
    pin,
    /** How many times agentd (or this fake) closed the link; see waitForClose. */
    closes: 0,
    /**
     * Resolves when the link has closed more times than `since` (take `since`
     * from `phone.closes` before causing the close, or a fast close is missed).
     */
    waitForClose(since, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        if (phone.closes > since) return resolve();
        const timer = setTimeout(() => reject(new Error("timed out waiting for the link to close")), timeoutMs);
        closeWaiters.push(() => { clearTimeout(timer); resolve(); });
      });
    },
    /** wshub: the steering secret from the pairing payload; sent in hello, only a wss hello that carries it steers. */
    steer,
    /** phonelink over TLS: the sha256 fingerprint of this phone's cert, once started. */
    fingerprint: undefined,
    frames,

    /**
     * phonelink: starts listening; agentd dials `{ port }` (handshake token is
     * checked when `token` is given). wshub: connects to `{ port, host?, token }`
     * and sends hello. Resolves with the port in use.
     */
    async start({ port = 0, host = "127.0.0.1", token } = {}) {
      if (started) throw new Error("fake phone already started");
      started = true;
      return transport === "phonelink"
        ? startPhoneLink({ port, host, token })
        : startWsHub({ port, host, token });
    },

    send(frame) {
      if (!writeFrame) throw new Error("fake phone is not connected");
      writeFrame(frame);
    },

    /** Builds a v2 frame from CLI-style arguments, sends it and returns it. */
    sendFrame(type, args = [], options) {
      const frame = buildFrame(type, args, options);
      phone.send(frame);
      return frame;
    },

    waitFor(type, predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const matches = (frame) =>
        frame.type === type && (!predicate || predicate(frame));
      const existing = frames.find(matches);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== waiter_);
          reject(new Error(
            `timed out waiting for "${type}" (received: ${frames.map((f) => f.type).join(", ") || "nothing"})`,
          ));
        }, timeoutMs);
        const waiter_ = (frame) => {
          if (!matches(frame)) return false;
          clearTimeout(timer);
          resolve(frame);
          return true;
        };
        waiters.push(waiter_);
      });
    },

    close() {
      closeTransport();
      writeFrame = null;
    },
  };

  async function startPhoneLink({ port, host, token }) {
    const sockets = new Set();
    const identity = tls ? (cert ?? await phoneCert("phone")) : undefined;
    if (identity) phone.fingerprint = identity.fingerprint256 ?? tlsFingerprint(identity.cert);
    const onConnection = (socket) => {
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); noteClosed(); });
      socket.on("error", () => {});
      writeFrame = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          const frame = line ? parse(line) : undefined;
          if (frame) {
            record(frame);
            if (frame.type === "hello") {
              const accepted = token === undefined || frame.token === token;
              writeFrame(accepted
                ? { type: "hello_ack", v: 1 }
                : { type: "hello_reject", v: 1, reason: "bad_token" });
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
    };
    const server = identity
      ? tlsModule.createServer({ key: identity.key, cert: identity.cert }, onConnection)
      : net.createServer(onConnection);
    // A refused handshake (agentd pinned another cert) is the test's business, not noise.
    server.on("tlsClientError", () => {});
    closeTransport = () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    };
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve({ port: server.address().port }));
    });
  }

  function startWsHub({ port, host, token }) {
    const expected = tls ? normalizeFingerprint(pin ?? "") : undefined;
    if (tls && !expected) {
      return Promise.reject(new Error("a TLS wshub fake phone needs `pin`: agentd's sha256 fingerprint"));
    }
    const socket = tls
      ? new WebSocket(`wss://${host}:${port}`, { rejectUnauthorized: false })
      : new WebSocket(`ws://${host}:${port}`);
    writeFrame = (frame) => socket.send(JSON.stringify(frame));
    closeTransport = () => socket.terminate();
    socket.on("close", noteClosed);
    socket.on("message", (data) => {
      const frame = parse(data.toString());
      if (frame) record(frame);
    });
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      // The pin is the only identity check there is, so it runs before the
      // token can leave: a socket that fails it is dropped before "open".
      socket.once("upgrade", (response) => {
        if (!expected) return;
        const actual = response.socket.getPeerCertificate().fingerprint256;
        if (actual !== expected) {
          socket.terminate();
          reject(new Error(`pin mismatch: agentd presented ${actual}, expected ${expected}`));
        }
      });
      socket.once("open", () => {
        socket.off("error", reject);
        socket.on("error", () => {});
        socket.send(JSON.stringify({
          type: "hello",
          v: 1,
          token,
          ...(phone.steer === undefined ? {} : { steer: phone.steer }),
          client: { name: "fake-phone", version: "test" },
        }));
        resolve({ port });
      });
    });
  }

  return phone;
}

function tlsFingerprint(certPem) {
  return new (require("node:crypto").X509Certificate)(certPem).fingerprint256;
}

/** `--flag value` pairs first; the first token that is not a flag starts the frame to send. */
function parseArgs(argv) {
  const flags = {};
  let index = 0;
  while (index < argv.length && argv[index].startsWith("--")) {
    flags[argv[index].slice(2)] = argv[index + 1];
    index += 2;
  }
  return { flags, frame: argv.slice(index) };
}

async function main() {
  const { flags: args, frame } = parseArgs(process.argv.slice(2));
  const phone = createFakePhone({
    transport: args.transport,
    tls: args.tls === "true",
    pin: args.pin,
    steer: process.env.FAKE_PHONE_STEER
      ?? (args["steer-file"] ? require("node:fs").readFileSync(args["steer-file"], "utf8").trim() : undefined),
    onFrame: (received) => process.stdout.write(`${JSON.stringify(received)}\n`),
  });
  const { port } = await phone.start({
    port: args.port === undefined ? 0 : Number(args.port),
    host: args.host,
    token: args.token,
  });
  process.stderr.write(`fake phone (${args.transport}) on port ${port}\n`);
  if (frame.length > 0) {
    // The link needs a moment to finish its handshake before agentd listens.
    const sent = await new Promise((resolve) => {
      const attempt = () => {
        try {
          resolve(phone.sendFrame(frame[0], frame.slice(1)));
        } catch (error) {
          if (error.message === "fake phone is not connected") setTimeout(attempt, 200);
          else throw error;
        }
      };
      phone.waitFor("snapshot", undefined, 30000).then(attempt, attempt);
    });
    process.stderr.write(`sent ${JSON.stringify(sent)}\n`);
  }
  const finish = () => {
    phone.close();
    process.exit(0);
  };
  process.on("SIGINT", finish);
  if (args.wait !== undefined) setTimeout(finish, Number(args.wait));
}

module.exports = { createFakePhone, buildFrame };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
