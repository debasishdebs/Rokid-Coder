# mobile

The phone side of Rokid-Coder, built by the root Gradle build.

- `app/`: the one phone app, module `:mobile:app`. It runs the Agents code in-process on
  the phone core (`:phone-core`) through `GlassesSurface`. See `app/README.md`.
  `./gradlew :mobile:app:checkRelease` runs its release manifest, dex and dependency checks.
- `caller-test/`: an unrelated app signed with its own test key, module `:mobile:caller-test`.
  Its instrumented test proves it can neither bind nor start any service of the phone app:
  `./gradlew :mobile:app:installDebug :mobile:caller-test:connectedDebugAndroidTest` on an
  emulator (`.github/workflows/emulator.yml`).
