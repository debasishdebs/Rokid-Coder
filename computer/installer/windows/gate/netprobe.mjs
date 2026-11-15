#!/usr/bin/env node
// netprobe: the Windows gate's network checks (W3, W4), run with the bundled node
// (`~/.rokid-coder/bin/rokid-node netprobe.mjs ...`) on either side of the link.
// It carries no secrets: it prints certificate fingerprints, addresses and sizes,
// never a key or a payload it did not send itself.
//
//   listen-tls --port <p> --cert <pem> --key <pem>   prints the fp of the cert it was given, then each peer
//   dial-tls --host <h> --port <p>                   prints the peer's cert fp
//   listen-udp --port <p>                            prints each datagram's source and size
//   send-udp (--broadcast | --host <h>) --port <p>   sends one probe datagram
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

const PROBE = "rokid-netprobe";
const TIMEOUT_MS = 8000;

function parse(argv) {
  const [mode, ...rest] = argv;
  const options = { mode };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--broadcast") options.broadcast = true;
    else if (["--port", "--host", "--cert", "--key"].includes(arg)) options[arg.slice(2)] = rest[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.port !== undefined) {
    options.port = Number(options.port);
    // 0 lets a listener take any free port; dial-tls and send-udp need a real one.
    const min = options.mode === "listen-tls" || options.mode === "listen-udp" ? 0 : 1;
    if (!Number.isInteger(options.port) || options.port < min || options.port > 65535) throw new Error("--port needs a port number");
  }
  return options;
}

const need = (options, ...names) => {
  for (const name of names) if (options[name] === undefined) throw new Error(`${options.mode} needs --${name}`);
};

export const fingerprintOf = (pem) => new crypto.X509Certificate(pem).fingerprint256;

function listenTls(options) {
  need(options, "port", "cert", "key");
  const cert = fs.readFileSync(options.cert);
  const server = tls.createServer({ cert, key: fs.readFileSync(options.key) }, (socket) => {
    console.log(`peer ${socket.remoteAddress}:${socket.remotePort}`);
    socket.end(`${PROBE}\n`);
  });
  server.on("tlsClientError", (error) => console.log(`peer handshake failed: ${error.code ?? error.message}`));
  server.listen(options.port, "0.0.0.0", () => console.log(`fp ${fingerprintOf(cert)}\nlistening tls 0.0.0.0:${server.address().port}`));
}

function dialTls(options) {
  need(options, "host", "port");
  // The fingerprint is the check: the probe trusts nothing and only reports what answered.
  const socket = tls.connect({ host: options.host, port: options.port, rejectUnauthorized: false }, () => {
    const peer = socket.getPeerX509Certificate();
    console.log(`fp ${peer ? peer.fingerprint256 : "none"}`);
    socket.end();
    process.exitCode = peer ? 0 : 1;
  });
  socket.setTimeout(TIMEOUT_MS, () => {
    console.log(`timeout dialing ${options.host}:${options.port}`);
    socket.destroy();
    process.exitCode = 2;
  });
  socket.on("error", (error) => {
    console.log(`error dialing ${options.host}:${options.port}: ${error.code ?? error.message}`);
    process.exitCode = 1;
  });
}

function listenUdp(options) {
  need(options, "port");
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("message", (message, from) => {
    const probe = message.toString("utf8").startsWith(PROBE);
    console.log(`datagram from ${from.address}:${from.port} ${message.length} bytes${probe ? " (probe)" : ""}`);
  });
  socket.bind(options.port, "0.0.0.0", () => console.log(`listening udp 0.0.0.0:${socket.address().port}`));
}

function sendUdp(options) {
  need(options, "port");
  if (!options.broadcast && !options.host) throw new Error("send-udp needs --broadcast or --host");
  const target = options.broadcast ? "255.255.255.255" : options.host;
  const socket = dgram.createSocket("udp4");
  socket.bind(0, () => {
    if (options.broadcast) socket.setBroadcast(true);
    socket.send(`${PROBE} ${new Date().toISOString()}`, options.port, target, (error) => {
      console.log(error ? `error sending to ${target}:${options.port}: ${error.code ?? error.message}` : `sent to ${target}:${options.port}`);
      process.exitCode = error ? 1 : 0;
      socket.close();
    });
  });
}

const MODES = { "listen-tls": listenTls, "dial-tls": dialTls, "listen-udp": listenUdp, "send-udp": sendUdp };

export function main(argv) {
  const options = parse(argv);
  const run = MODES[options.mode];
  if (!run) throw new Error(`usage: netprobe ${Object.keys(MODES).join("|")} [options]`);
  run(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`netprobe: ${error.message}`);
    process.exitCode = 2;
  }
}
