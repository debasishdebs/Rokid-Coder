# plugin

The coding-agent plugins that opt a session into Rokid-Coder.

- `claude-code/`: the Claude Code plugin (`/rokid:on`, `/rokid:off`, `/rokid:pair`,
  `/rokid:status`), listed by `.claude-plugin/marketplace.json`.
- `codex/`: the Codex plugin, listed by `.agents/plugins/marketplace.json`.

Each carries its own copy of the hook forwarder, `bin/hook-forward.js`. Do not edit it
here: `npm run build` in `computer/` regenerates both copies, and the computer tests
fail when a copy is stale.
