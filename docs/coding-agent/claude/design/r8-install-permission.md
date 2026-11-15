# R8: does the phone app need `REQUEST_INSTALL_PACKAGES`?

Plan 6c T5, `[CR 11]`. **Conclusion: not needed.** To be confirmed on hardware by T13 row
`GLS-INSTALL`.

## Why the question exists

The 1.0 phone app installs the glasses app onto the glasses itself (§2 step 3, R7). Google Play
restricts `REQUEST_INSTALL_PACKAGES` to apps whose core purpose is installing packages, so the
permission would be a Play blocker (R8). 6a's `checkReleaseManifest` refuses it unless a single
recorded allowance says it is needed.

## Evidence

1. **The install happens on the glasses, not on the phone.**
   - Onboarding's `GlassesInstallController` copies the bundled asset and calls
     `HubCore.glassesInstaller.install(file, expected, onProgress)`
     (`mobile/app/.../onboarding/GlassesInstallController.kt`).
   - The core's `CxrGlassesAppInstaller` verifies the copy, then dispatches
     `appUploadAndInstall(copy.absolutePath, cbk)` on its CXR app slot
     (`vendor/nexus/phone-core/.../GlassesAppInstaller.kt:106`; upstream's `BusHubService.kt:4453`
     before 6a moved it into the core).
   - `CXRLink.appUploadAndInstall` opens the file as a read-only `ParcelFileDescriptor` and hands it
     to the Hi Rokid service with `uploadAndInstallApk(name, fd, glassApp)`
     (`CxrGlobal/lib/.../CXRLink.kt:406-429`). The phone uploads; the glasses install. The phone's
     `PackageManager` never sees an install session.
2. **The release merged manifest has no `REQUEST_INSTALL_PACKAGES`.**
   - No module the app depends on declares it (only the upstream shell `:phone-hub` does, and it is
     not a dependency of `:mobile:app`).
   - `ReleaseManifestTest.release_manifest_has_no_request_install_packages` reads the release merged
     manifest, and the unit-test task runs 6a's `checkReleaseManifest` policy first, so a library
     that starts contributing it fails the suite. The fix would then be a
     `tools:node="remove"` entry in `mobile/app/src/main/AndroidManifest.xml`.
3. **The release dex makes no package-install call.** T5 built `:mobile:app:assembleRelease` signed
   with a throwaway key, with `rokid.releaseSignerSha256` set to that key's digest, and ran
   `checkRelease` on it (manifest, dex class table and dependencies: all clean). Across
   `classes.dex` and `classes2.dex`, the occurrences of each string are:

   | String | Count |
   |---|---|
   | `Landroid/content/pm/PackageInstaller` | 0 |
   | `android.intent.action.INSTALL_PACKAGE` | 0 |
   | `ACTION_INSTALL_PACKAGE` | 0 |
   | `REQUEST_INSTALL_PACKAGES` | 0 |
   | `MANAGE_UNKNOWN_APP_SOURCES` | 0 |
   | `uploadAndInstallApk` (the Hi Rokid service call) | 1 |

## What follows

- `checkReleaseManifest` keeps rejecting the permission (`allowRequestInstallPackages = false`).
- **If T13 `GLS-INSTALL` disproves this** (the Hi Rokid service refuses an upload from an app without
  the permission, or a ROM requires it), the fix wave:
  1. adds `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />` to the
     phone manifest;
  2. sets the one allowance `checkReleaseManifest` reads (`allowRequestInstallPackages = true` on
     `releaseManifestPolicy` in `mobile/app/build.gradle.kts`), with a comment pointing here;
  3. records it below as the Play blocker R8, so the Play decision after 1.0 starts from it.

## Record

| Date | Source | Result |
|---|---|---|
| 2026-11-15 | T5 static evidence (above) | Not needed |
| | T13 `GLS-INSTALL` | pending |
