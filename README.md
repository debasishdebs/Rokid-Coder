# Rokid-Coder

Rokid-Coder puts your Claude Code and Codex sessions on Rokid glasses: permission prompts, questions and progress on the HUD, answered from the glasses.
It is built on [Rokid Nexus](https://github.com/Anezium/Rokid-Nexus), which is vendored here.

## Download

Get the latest release: <https://github.com/debasishdebs/Rokid-Coder/releases/latest>

You install two things: the phone app (which brings the glasses app with it), and the helper on your computer. Start on the phone: the app walks you through the rest.

| Install | Guide |
|---|---|
| The computer (macOS, or Windows 11 with WSL 2) | [`computer/README.md`](computer/README.md) |
| The Claude Code and Codex plugins | [`plugin/README.md`](plugin/README.md) |
| The phone app | [`mobile/README.md`](mobile/README.md) |
| The glasses app | [`glasses/README.md`](glasses/README.md) |

What Rokid-Coder does with your data: [`PRIVACY.md`](PRIVACY.md).

## Building from source

You need Node 22, JDK 17, the Android SDK, and the CXR library checked out next to this
repository at `../CxrGlobal` (Anezium/CxrGlobal v0.3.0). `vendor/CxrGlobal` links to it,
so the vendored Nexus build finds it too.

```bash
npm ci                             # the computer and plugin workspaces
(cd computer && npm test)
./gradlew :shared:test :bus-client:testDebugUnitTest :ink-engine:test \
  :phone-hub:testDebugUnitTest :glasses-hub:testDebugUnitTest \
  :mobile:app:testDebugUnitTest --continue
```

The upstream modules keep their upstream Gradle names (`:shared`, `:phone-hub`, …) and
live under `vendor/nexus`. `.github/workflows/tests.yml` runs the product suites;
`upstream-validation.yml` builds `vendor/nexus` on its own and runs upstream's full list.
`docs/coding-agent/` holds the designs, plans, reviews and the handoff.

`scripts/upstream-sync.sh` merges upstream `main` into `vendor/nexus` with
`git subtree pull --squash`. A clean merge exits 0, and every suite must then pass. A
merge that conflicts is aborted with exit 2, naming the conflicted files and the
`PATCHES.md` rows that touch them. Every change we make inside `vendor/nexus` is its own
commit with a row in `PATCHES.md`.

## License

Apache 2.0, see `LICENSE` and `NOTICE`.
