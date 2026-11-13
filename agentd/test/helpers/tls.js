"use strict";
/**
 * Test certificates, generated once per test process (a test file is one
 * process): RSA key generation is the slow part, so no test makes its own.
 *
 *   agentCert()      agentd's identity, made by the real ensureAgentCert.
 *   phoneCert(name)  a phone's self-signed identity; distinct names give
 *                    distinct certs, for the wrong-pin cases.
 *   seedAgentCert()  copies the shared agentd cert into a daemon's tls dir, so
 *                    the daemon finds it instead of generating its own.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { generate } = require("selfsigned");
const { ensureAgentCert, fingerprintOfCert } = require("../../dist/tls.js");

let agentPromise;
const phonePromises = new Map();
const scratch = [];

process.on("exit", () => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

function agentCert() {
  agentPromise ??= (async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rokid-coder-test-agent-cert-"));
    scratch.push(dir);
    const cert = await ensureAgentCert(dir);
    return { ...cert, dir };
  })();
  return agentPromise;
}

function phoneCert(name = "phone") {
  if (!phonePromises.has(name)) {
    phonePromises.set(name, (async () => {
      const pems = await generate([{ name: "commonName", value: `rokid-coder-test-${name}` }], {
        algorithm: "sha256",
      });
      return { key: pems.private, cert: pems.cert, fingerprint256: fingerprintOfCert(pems.cert) };
    })());
  }
  return phonePromises.get(name);
}

async function seedAgentCert(tlsDir) {
  const { dir } = await agentCert();
  await fsp.mkdir(tlsDir, { recursive: true });
  for (const file of ["agentd.key", "agentd.crt"]) {
    await fsp.copyFile(path.join(dir, file), path.join(tlsDir, file));
  }
}

module.exports = { agentCert, phoneCert, seedAgentCert };
