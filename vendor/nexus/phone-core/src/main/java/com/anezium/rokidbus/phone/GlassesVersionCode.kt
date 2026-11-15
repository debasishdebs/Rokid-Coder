package com.anezium.rokidbus.phone

/** The hub release convention: versionCode = major * 10000 + minor * 100 + patch. */
object GlassesVersionCode {
    fun fromSemVersion(version: NexusSemVersion): Long? {
        if (version.major !in 0..210000L || version.minor !in 0..99L || version.patch !in 0..99L) {
            return null
        }
        return (version.major * 10000 + version.minor * 100 + version.patch)
            .takeIf { it in 1..2100000000L }
    }

    fun fromVersionName(versionName: String?): Long? =
        versionName?.trim()?.let(NexusSemVersion::parse)?.let(::fromSemVersion)
}
