package com.anezium.rokidbus.phone

data class NexusSemVersion(
    val major: Long,
    val minor: Long,
    val patch: Long,
) : Comparable<NexusSemVersion> {
    override fun compareTo(other: NexusSemVersion): Int =
        compareValuesBy(this, other, NexusSemVersion::major, NexusSemVersion::minor, NexusSemVersion::patch)

    override fun toString(): String = "$major.$minor.$patch"

    companion object {
        private val VERSION_PATTERN = Regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")
        private val APP_TAG_PATTERN = Regex("^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$")

        fun parse(versionName: String): NexusSemVersion? = parseMatch(VERSION_PATTERN.matchEntire(versionName))

        /** Only bare app tags are accepted; plugin and SDK tags cannot match this shape. */
        fun fromAppTag(tag: String): NexusSemVersion? = parseMatch(APP_TAG_PATTERN.matchEntire(tag))

        private fun parseMatch(match: MatchResult?): NexusSemVersion? {
            match ?: return null
            val parts = match.groupValues.drop(1).map { it.toLongOrNull() ?: return null }
            return NexusSemVersion(parts[0], parts[1], parts[2])
        }
    }
}
