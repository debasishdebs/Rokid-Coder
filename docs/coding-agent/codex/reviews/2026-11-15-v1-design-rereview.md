1. **NOT RESOLVED** — R1 requires confirmation but defines a six-digit hash without nonce ownership or commitment, leaving peer authentication incomplete.
2. **RESOLVED** — R2 selects an in-process `GlassesSurface` adapter covering surfaces, input, speech and lifecycle.
3. **RESOLVED** — R3 specifies the library/shell split, release-manifest inspection and unrelated-app rejection test.
4. **RESOLVED** — R4 selects Ubuntu/WSL2, Linux binaries, WSL-owned state and scheduled startup.
5. **RESOLVED** — R4 documents connection directions, ports, discovery fallback and host Tailscale integration.
6. **RESOLVED** — R5 specifies runtime wrappers, Node 22, matching native artifacts and clean-machine gates.
7. **NOT RESOLVED** — R6 still omits build ownership; `vendor/../CxrGlobal` also fails to identify the required sibling checkout (`settings.gradle.kts:77`).
8. **RESOLVED** — R7 defines bundled metadata, verification before each push, version handling and package/component migration.
9. **RESOLVED** — R8 withdraws Play compatibility and explicitly investigates the installation permission.
10. **NOT RESOLVED** — R9 assumes a glasses action authorizes background microphone activation; it establishes no applicable Android exemption.
11. **RESOLVED** — R10 carries forward the behavior contract and gates both tools/platforms on hardware, recovery and installer checks.
12. **RESOLVED** — R11 discloses external providers and excludes Nexus cloud speech engines.
13. **NOT RESOLVED** — R12 fixes the TLS exceptions but fails to preserve the repo’s application-level SPP protections.

New Critical/Important problems introduced:

- **Critical — R1’s custom SAS permits offline matching attempts.** Without a commitment protocol, an intermediary can vary nonce/certificate inputs to seek matching short codes. Use a reviewed SAS exchange or authenticated QR binding; see [RFC 6189 §4.4.1.1](https://www.rfc-editor.org/rfc/rfc6189#section-4.4.1.1).
- **Important — R9 asserts an unsupported microphone exemption.** A remote glasses gesture alone does not establish eligibility for background microphone activation. Existing `BusHubService.kt:4893–4945` explicitly handles promotion failure; define a permitted activation path under [Android’s restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
- **Important — R12 risks downgrading hub authentication.** Bluetooth encryption does not replace existing `SppAuthProtocol`, authenticated enrollment and frame replay protection (`BusHubService.kt:3865`, `AuthenticatedSppServer.kt:120`). Explicitly retain them.

Static review; no builds or tests run.

VERDICT: NOT READY