#!/usr/bin/env node
// Copies the standalone hook forwarder into each coding-agent plugin so a plugin
// installed from a git marketplace carries its own copy. The copies are committed.
const { copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "..", "dist", "hook-forward.js");
const pluginsDir = path.resolve(__dirname, "..", "..", "plugins");

for (const plugin of ["claude-code", "codex"]) {
  const target = path.join(pluginsDir, plugin, "bin", "hook-forward.js");
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}
