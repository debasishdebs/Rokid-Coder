# glasses

The glasses side of Rokid-Coder. `:glasses-app` (`glasses/app`) is the Rokid Coder glasses
app: a thin shell over the vendored `:glasses-core`, with our application id
(`rokid.glassesApplicationId` in `gradle.properties`), our launcher label and icon, and the
release signing of `gradle/plugin-release-signing.gradle`. Its Application hands the core the
application-id pair through `GlassesCoreConfig`. Its `versionCode` is derived from its
`versionName` as `major * 10000 + minor * 100 + patch`, the code the phone computes from the
version the glasses announce.

The upstream Nexus glasses hub, `:glasses-hub` in `vendor/nexus/glasses-hub`, keeps
upstream's application id over the same core.
