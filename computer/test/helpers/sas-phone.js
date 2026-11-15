"use strict";
/**
 * The phone's half of a SAS pairing session, for agentd tests, written against
 * raw node crypto rather than agentd's own module so the two cross-check:
 *
 *   wssSasPhone(...)        dials agentd's WsHub over wss with a client cert
 *   phoneLinkSasPhone(...)  listens as the phone; agentd's PhoneLink dials it
 *
 * Both expose the same responder: it answers sas_commit with a nonce, checks
 * the reveal against the commitment, computes the code, and confirms only when
 * the test calls confirm(). Credentials are stored (or the store "fails") as
 * the options say, and a pair_commit_query is answered with the proof.
 */
const crypto = require("node:crypto");
const tls = require("node:tls");
const WebSocket = require("ws");

const fpOf = (raw) => crypto.createHash("sha256").update(raw).digest("hex").toUpperCase().match(/../g).join(":");

function expectedCommit(nc, agentdFp, phoneFp) {
  return crypto.createHash("sha256")
    .update(Buffer.concat([Buffer.from("rokid-sas-v1"), nc, Buffer.from(agentdFp), Buffer.from(phoneFp)]))
    .digest("hex");
}

function sasCode(nc, np, agentdFp, phoneFp) {
  const d = crypto.createHash("sha256")
    .update(Buffer.concat([Buffer.from("rokid-sas-v1"), nc, np, Buffer.from(agentdFp), Buffer.from(phoneFp)]))
    .digest();
  return String(parseInt(d.subarray(0, 3).toString("hex").slice(0, 5), 16) % 1_000_000).padStart(6, "0");
}

function commitProof(steer, attempt, agentdFp, phoneFp) {
  return crypto.createHmac("sha256", Buffer.from(steer))
    .update(Buffer.concat([Buffer.from("rokid-commit-v1"), Buffer.from(attempt), Buffer.from(agentdFp), Buffer.from(phoneFp)]))
    .digest("hex");
}

/**
 * options:
 *   storage: "ok" (default) | "fail" (answers pair_abort storage) | "silent" (stores, never says so)
 *   tamperReveal: true     treats every reveal as not matching the commitment
 */
function responder(send, phoneFp, options = {}) {
  const state = {
    frames: [],
    attempt: undefined,
    commit: undefined,
    np: undefined,
    code: undefined,
    agentdFp: undefined,
    credentials: undefined,
    committedSent: 0,
    aborted: undefined,
  };
  const waiters = [];
  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate()) {
        const [{ resolve, timer }] = waiters.splice(i, 1);
        clearTimeout(timer);
        resolve();
      }
    }
  };
  const self = {
    state,
    receive(frame) {
      state.frames.push(frame);
      switch (frame.type) {
        case "sas_commit":
          state.attempt = frame.attempt;
          state.commit = frame.c;
          state.np = crypto.randomBytes(32);
          send({ type: "sas_nonce", v: 2, attempt: frame.attempt, np: state.np.toString("hex") });
          break;
        case "sas_reveal": {
          const nc = Buffer.from(frame.nc, "hex");
          if (options.tamperReveal || expectedCommit(nc, state.agentdFp, phoneFp) !== state.commit) {
            state.aborted = "bad_reveal";
            send({ type: "pair_abort", v: 2, attempt: frame.attempt, reason: "bad_reveal" });
            break;
          }
          state.code = sasCode(nc, state.np, state.agentdFp, phoneFp);
          break;
        }
        case "pair_credentials":
          if (options.storage === "fail") {
            send({ type: "pair_abort", v: 2, attempt: frame.attempt, reason: "storage" });
            break;
          }
          state.credentials = frame;
          if (options.storage !== "silent") {
            state.committedSent += 1;
            send({ type: "pair_committed", v: 2, attempt: frame.attempt });
          }
          break;
        case "pair_commit_query": {
          const steer = options.proofSteer ?? state.credentials?.steer;
          if (steer) {
            send({ type: "pair_committed", v: 2, attempt: frame.attempt, proof: commitProof(steer, frame.attempt, state.agentdFp, phoneFp) });
          }
          break;
        }
        case "pair_abort":
          state.aborted = frame.reason;
          break;
        default:
          break;
      }
      notify();
    },
    /** The phone-side human's answer. */
    confirm(ok = true) {
      send({ type: "sas_confirm", v: 2, attempt: state.attempt, ok });
    },
    waitFor(predicate, message = "timed out waiting for the SAS phone", timeoutMs = 3000) {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        waiters.push({ predicate, resolve, timer });
      });
    },
    waitForFrame(type, timeoutMs) {
      return self.waitFor(() => state.frames.some((f) => f.type === type), `no ${type}`, timeoutMs).then(
        () => state.frames.find((f) => f.type === type),
      );
    },
  };
  return self;
}

/** Dials agentd's wss as a phone in pairing mode: says nothing, waits for sas_commit. */
async function wssSasPhone({ port, cert, options = {} }) {
  const socket = new WebSocket(`wss://127.0.0.1:${port}`, {
    key: cert.key,
    cert: cert.cert,
    rejectUnauthorized: false,
  });
  let closeCode;
  const closed = new Promise((resolve) => socket.once("close", (code) => { closeCode = code; resolve(code); }));
  socket.on("error", () => {});
  const phone = responder((frame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }, cert.fingerprint256, options);
  socket.on("message", (data) => phone.receive(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  phone.state.agentdFp = fpOf(socket._socket.getPeerCertificate().raw);
  return Object.assign(phone, {
    socket,
    closed,
    get closeCode() { return closeCode; },
    sendRaw: (frame) => socket.send(JSON.stringify(frame)),
    close: () => socket.terminate(),
  });
}

/**
 * Listens as the phone for agentd's PhoneLink dial. Each connection gets its
 * own responder; `hello` lines are recorded and acknowledged as a paired phone
 * would, so a reconnect after pairing can be seen to need no SAS.
 */
async function phoneLinkSasPhone({ cert, options = {} }) {
  const sessions = [];
  const sockets = new Set();
  const server = tls.createServer({ key: cert.key, cert: cert.cert, requestCert: true, rejectUnauthorized: false }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const session = responder((frame) => socket.write(`${JSON.stringify(frame)}\n`), cert.fingerprint256, options);
    session.socket = socket;
    session.hellos = [];
    session.closed = new Promise((resolve) => socket.once("close", resolve));
    session.state.agentdFp = fpOf(socket.getPeerCertificate(true).raw);
    sessions.push(session);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame.type === "hello") {
          session.hellos.push(frame);
          socket.write('{"type":"hello_ack","v":1}\n');
        } else {
          session.receive(frame);
        }
      }
    });
  });
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const waitForSession = async (index, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (sessions[index]) return sessions[index];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no PhoneLink connection #${index}`);
  };
  return {
    port,
    sessions,
    waitForSession,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

module.exports = { wssSasPhone, phoneLinkSasPhone, commitProof, sasCode, expectedCommit, fpOf };
