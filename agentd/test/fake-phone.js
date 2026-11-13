"use strict";
/**
 * Fake phone for agentd tests, usable against both phone transports:
 *
 *   "phonelink"  the fake LISTENS on TCP (newline-delimited JSON) and agentd's
 *                PhoneLink dials it, as a real phone does.
 *   "wshub"      the fake CONNECTS to agentd's WsHub over WebSocket.
 *
 * `tls` is a test-only marker: real TLS does not exist yet, so `tls: true`
 * only sets `phone.trusted` for later authorization tests. Nothing in agentd
 * reads it; no production path marks a link trusted.
 *
 * Also runnable as a CLI that prints every received frame as a JSON line:
 *   node test/fake-phone.js --transport phonelink [--port 8792] [--token T]
 *   node test/fake-phone.js --transport wshub --port 8792 --token T
 */
const net = require("node:net");
const WebSocket = require("ws");

const DEFAULT_TIMEOUT_MS = 2000;

function createFakePhone({ transport, tls = false, pin } = {}) {
  if (transport !== "phonelink" && transport !== "wshub") {
    throw new Error(`unknown fake phone transport: ${transport}`);
  }

  const frames = [];
  let waiters = [];
  let writeFrame = null;
  let closeTransport = () => {};
  let started = false;

  function record(frame) {
    frames.push(frame);
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
    /** Test-only: true when the harness was created with `tls: true`. */
    trusted: tls === true,
    pin,
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

  function startPhoneLink({ port, host, token }) {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
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
    });
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
    const socket = new WebSocket(`ws://${host}:${port}`);
    writeFrame = (frame) => socket.send(JSON.stringify(frame));
    closeTransport = () => socket.terminate();
    socket.on("message", (data) => {
      const frame = parse(data.toString());
      if (frame) record(frame);
    });
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        socket.off("error", reject);
        socket.on("error", () => {});
        socket.send(JSON.stringify({
          type: "hello",
          v: 1,
          token,
          client: { name: "fake-phone", version: "test" },
        }));
        resolve({ port });
      });
    });
  }

  return phone;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    args[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phone = createFakePhone({
    transport: args.transport,
    tls: args.tls === "true",
    pin: args.pin,
  });
  const originalPush = phone.frames.push.bind(phone.frames);
  phone.frames.push = (...items) => {
    for (const item of items) process.stdout.write(`${JSON.stringify(item)}\n`);
    return originalPush(...items);
  };
  const { port } = await phone.start({
    port: args.port === undefined ? 0 : Number(args.port),
    host: args.host,
    token: args.token,
  });
  process.stderr.write(`fake phone (${args.transport}) on port ${port}\n`);
  process.on("SIGINT", () => {
    phone.close();
    process.exit(0);
  });
}

module.exports = { createFakePhone };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
