# Rokid-Coder

Rokid-Coder puts your Claude Code and Codex sessions on Rokid glasses: permission
prompts, questions and progress on the HUD, answered from the glasses. It is built
on [Rokid Nexus](https://github.com/Anezium/Rokid-Nexus), which is vendored here.

## Layout

| Path | What it is |
|---|---|
| `computer/` | The daemon on your computer (Node, TypeScript). It follows the sessions and talks to the phone over pinned TLS. |
| `plugin/claude-code`, `plugin/codex` | The Claude Code and Codex plugins that opt a session in (`/rokid:on`). Listed by `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`. |
| `mobile/` | The phone side. `mobile/agents` is the Agents app, Gradle module `:mobile:agents`. |
| `glasses/` | The glasses side (the glasses app arrives in Plan 6a). |
| `contracts/` | Wire fixtures shared by the computer and phone tests. |
| `vendor/nexus/` | Upstream Rokid-Nexus as a git subtree, with our patches listed in `vendor/nexus/PATCHES.md`. |
| `docs/coding-agent/` | Designs, plans, reviews and the handoff. |

## Build and test

You need Node 22, JDK 17, the Android SDK, and the CXR library checked out next to this
repository at `../CxrGlobal` (Anezium/CxrGlobal v0.3.0). `vendor/CxrGlobal` links to it,
so the vendored Nexus build finds it too.

```bash
npm ci                             # the computer and plugin workspaces
(cd computer && npm test)
./gradlew :shared:test :bus-client:testDebugUnitTest :ink-engine:test \
  :phone-hub:testDebugUnitTest :glasses-hub:testDebugUnitTest \
  :mobile:agents:testDebugUnitTest --continue
```

The upstream modules keep their upstream Gradle names (`:shared`, `:phone-hub`, …) and
live under `vendor/nexus`. `.github/workflows/tests.yml` runs the product suites;
`upstream-validation.yml` builds `vendor/nexus` on its own and runs upstream's full list.

## Upstream updates

`scripts/upstream-sync.sh` merges upstream `main` into `vendor/nexus` with
`git subtree pull --squash`. A clean merge exits 0, and every suite must then pass. A
merge that conflicts is aborted with exit 2, naming the conflicted files and the
`PATCHES.md` rows that touch them. Every change we make inside `vendor/nexus` is its own
commit with a row in `PATCHES.md`.

## License

Apache 2.0, see `LICENSE` and `NOTICE`.
