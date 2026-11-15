# Rokid Coder plugins

The Claude Code and Codex plugins that opt a session into Rokid Coder. In a session, `/rokid:on` attaches it to your glasses (`rokid:on` in Codex).

## You normally install nothing here

The computer installer sets the plugins up for you, for every CLI it finds: it registers the `rokid-coder` marketplace from its own versioned bundle and installs the `rokid` plugin from it. If `rk claude` or `rk codex` installs the CLI for you later, it sets the plugin up right after. If you installed the CLI yourself, run:

```bash
rokid-setup plugins sync [--tool claude|codex]
```

`rokid-setup plugins status --json` shows what is installed, and `rokid-setup plugins remove [--tool claude|codex]` takes the plugins out again. Setup never edits your Claude or Codex config files itself; it only runs those tools' own plugin commands.

## Manual install

Only if setup could not do it (it says so, with the exact step: for Claude Code, run `/plugin` and install `rokid` from the `rokid-coder` marketplace; for Codex, open `/plugins` and install Rokid-Coder). A CLI whose plugin command has no non-interactive install verb gets its marketplace registered and this one step left to you. Point each CLI at the plugin folder of the installed bundle:

| | macOS | Windows (inside WSL) |
|---|---|---|
| Bundle plugins folder | `/Library/Application Support/RokidCoder/<version>/plugins` | `~/.local/share/rokid-coder/<version>/plugins` |

```bash
# Claude Code
claude plugin marketplace add "<plugins folder>"
claude plugin install rokid@rokid-coder

# Codex
codex plugin marketplace add "<plugins folder>"
# then open /plugins inside Codex and install Rokid-Coder
```

From a source checkout, use the repository root instead of the bundle folder: `claude plugin marketplace add .` and `claude plugin install rokid@rokid-coder`.

## Use

- `/rokid:on` attaches the current session, `/rokid:off` detaches it, `/rokid:status` shows its state, and `/rokid:pair` opens the two-minute pairing window (in Codex: `rokid:on`, `rokid:off`, `rokid:status`, `rokid:pair`).
- Plugin mode shows progress, approvals and questions on the glasses, and lets you reply by voice while a session waits. Compact and model change need the launcher: start the session with `rk claude`.

## What is here

- `claude-code/`: the Claude Code plugin, listed by `.claude-plugin/marketplace.json`.
- `codex/`: the Codex plugin, listed by `.agents/plugins/marketplace.json`.

Each carries its own copy of the hook forwarder, `bin/hook-forward.js`. Do not edit it
here: `npm run build` in `computer/` regenerates both copies, and the computer tests
fail when a copy is stale.
