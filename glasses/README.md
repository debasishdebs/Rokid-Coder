# Rokid Coder on your glasses

The glasses app shows your Claude Code and Codex sessions on the HUD: approvals, questions, progress and Done, which you answer from the glasses.

## Install

You do not install it yourself, and you need no computer and no adb. The phone app carries the glasses app and installs it over the Rokid link:

1. Install the phone app ([`../mobile/README.md`](../mobile/README.md)) and connect your glasses in Hi Rokid.
2. Follow the phone app's setup to the **Glasses app** step. It checks the bundled app and installs it on the glasses, and shows the result.
3. Later, Settings, Glasses app on the phone updates or reinstalls it.

If a newer glasses app is already on the glasses, setup leaves it alone and says so. If you also use the upstream Rokid Nexus, see the coexistence note in the phone README: only one app can hold the link to your glasses at a time.

<!-- RECHECK-6C: the step names follow T5's onboarding. Confirm against the final strings. -->

## Building

The glasses side of Rokid-Coder. `:glasses-app` (`glasses/app`) is the Rokid Coder glasses
app: a thin shell over the vendored `:glasses-core`, with our application id
(`rokid.glassesApplicationId` in `gradle.properties`), our launcher label and icon, and the
release signing of `gradle/plugin-release-signing.gradle`. Its Application hands the core the
application-id pair through `GlassesCoreConfig`. Its `versionCode` is derived from its
`versionName` as `major * 10000 + minor * 100 + patch`, the code the phone computes from the
version the glasses announce.

The upstream Nexus glasses hub, `:glasses-hub` in `vendor/nexus/glasses-hub`, keeps
upstream's application id over the same core.
