# Rokid Coder on your glasses

The glasses app shows your Claude Code and Codex sessions on the HUD: approvals, questions, progress and Done, which you answer from the glasses.

## Install

You do not install it yourself, and you need no computer and no adb. The phone app carries the glasses app and installs it over the Rokid link:

1. Install the phone app ([`../mobile/README.md`](../mobile/README.md)) and connect your glasses in Hi Rokid.
2. Follow the phone app's setup to **Connect your glasses**. After the connection, its glasses-app screen checks the bundled app and installs it on the glasses (**Install on glasses** or **Update glasses app**), and shows the result.
3. Later, Settings, **Glasses app** on the phone opens the same screen to update or reinstall it.

If a newer glasses app is already on the glasses, setup leaves it alone and says so: update the phone app to match. If you also use the upstream Rokid Nexus, see the coexistence note in the phone README: only one app can hold the link to your glasses at a time.

## First-run setup on the glasses

After the install, open **Rokid Coder** on the glasses and switch it on in the Settings accessibility list. The app then sets itself up: it drives Settings through Wireless Debugging, pairs with itself over the glasses' own Wi-Fi address, and grants itself the one permission it needs. A line on the lens says Rokid Coder is setting itself up; keep the glasses on, it takes one to two minutes. If a step does not finish, the setup card offers a retry and shows a short support code (for example `PAIR-STALL`, or `TMO` with the last step it reached).

If you have a computer with adb, you can skip the automatic setup. Connect the glasses and run:

```
adb shell pm grant io.github.debasishdebs.rokidcoder.glasses android.permission.WRITE_SECURE_SETTINGS
```

Then open Rokid Coder on the glasses. With the permission granted it turns on its own accessibility service on launch, so no Settings navigation or Wireless Debugging pairing is needed.

## Building

The glasses side of Rokid-Coder. `:glasses-app` (`glasses/app`) is the Rokid Coder glasses
app: a thin shell over the vendored `:glasses-core`, with our application id
(`rokid.glassesApplicationId` in `gradle.properties`), our launcher label and icon, and the
release signing of the `rokid.release-signing` build-logic plugin (`build-logic/`, applied by
`:mobile:app` and `:glasses-app`). The plugin signs the release build type with the PKCS12 key named by
`NEXUS_RELEASE_KEYSTORE`, `NEXUS_RELEASE_KEYSTORE_PASSWORD` and `NEXUS_RELEASE_KEY_ALIAS` (all three or
none), fails a release assembly that lacks them, and fails unless the key's certificate SHA-256 equals
`rokid.releaseSignerSha256` in `gradle.properties`, the digest the phone pins the glasses APK to. Its
Application hands the core the application-id pair through `GlassesCoreConfig`. Its `versionCode` is derived from its
`versionName` as `major * 10000 + minor * 100 + patch`, the code the phone computes from the
version the glasses announce.

The upstream Nexus glasses hub, `:glasses-hub` in `vendor/nexus/glasses-hub`, keeps
upstream's application id over the same core.
