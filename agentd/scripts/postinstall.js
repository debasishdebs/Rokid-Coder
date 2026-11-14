#!/usr/bin/env node
"use strict";
// node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, and npm
// does not run node-pty's own install script by default. Without the bit every
// pty spawn fails with `posix_spawnp failed`. Set it here, on agentd's own copy
// only; src/launcher/pty.ts keeps a runtime backstop for installs that skipped
// this script. Never fails the install.
const fs = require("node:fs");
const path = require("node:path");

try {
  if (process.platform === "darwin") {
    const modules = path.join(__dirname, "..", "node_modules");
    const helper = path.join(modules, "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    // R132: only a file whose real path is inside agentd's own node_modules.
    const real = fs.existsSync(helper) ? fs.realpathSync(helper) : undefined;
    if (real && real.startsWith(fs.realpathSync(modules) + path.sep) && (fs.statSync(real).mode & 0o111) === 0) {
      fs.chmodSync(real, 0o755);
    }
  }
} catch {
  // Not fatal: the runtime backstop and the spawn error say what is wrong.
}
