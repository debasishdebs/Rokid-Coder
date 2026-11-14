1. **RESOLVED — Open R1:** R1′ specifies nonce ownership, commitment before disclosure, reveal verification, and confirmation on both devices.
2. **RESOLVED — Open R6:** R6′ assigns root Gradle/npm ownership and explicitly locates CxrGlobal beside the repository.
3. **RESOLVED — Open R9:** R9′ activates microphone foreground mode while the app is visible; reboot requires reopening, consistent with [Android restrictions](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone).
4. **RESOLVED — Open R12:** R12′ explicitly preserves SPP authentication, authenticated enrollment, and frame replay protection.
5. **RESOLVED — Prior Critical SAS finding:** R1′ fixes TLS fingerprints before the commitment exchange and permits only one attempt per window.
6. **RESOLVED — Prior Important microphone finding:** R9′ replaces the claimed glasses-gesture exemption with foreground activation and visible recovery.
7. **RESOLVED — Prior Important authentication finding:** R12′ marks existing application-level hub protections as mandatory preservation areas.

NEW Critical/Important problems: none found.
Static design review; no builds or tests run.
VERDICT: READY