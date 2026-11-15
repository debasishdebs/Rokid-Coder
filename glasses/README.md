# glasses

The glasses side of Rokid-Coder. `settings.gradle.kts` registers `:glasses-app`
(`glasses/app`) once that directory exists; until then the glasses run the vendored
Nexus glasses hub, `:glasses-hub` in `vendor/nexus/glasses-hub`.
