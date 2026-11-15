package com.anezium.rokidbus.glasses

import com.anezium.rokidbus.shared.AppIdentity

internal object SelfArmConstants {
    const val WATCHDOG_ASSET = "rokid-nexus-a11y-watchdog.sh"
    const val WATCHDOG_NAME = "rokid-nexus-a11y-watchdog"
    const val WATCHDOG_VERSION = "2026-07-17.1"
    const val WATCHDOG_REMOTE_PATH = "/data/local/tmp/rokid-nexus-a11y-watchdog.sh"
    const val WATCHDOG_PIDFILE = "/data/local/tmp/rokid-nexus-a11y-watchdog.pid"
    const val BRIDGE_ASSET = "rokid-nexus-cmd-bridge.sh"
    const val BRIDGE_VERSION = "2026-10-21.7"
    const val BRIDGE_REMOTE_PATH = "/data/local/tmp/rokid-nexus-cmd-bridge.sh"
    const val BRIDGE_PIDFILE = "/data/local/tmp/rokid-nexus-cmd-bridge.pid"
}

/** The accessibility service as Settings stores it: the glasses application id over the class. */
internal val AppIdentity.selfArmAccessibilityService: String
    get() = flattenedGlassesComponent(RokidBusAccessibilityService::class.java.name)

/** The short spelling some firmwares store; the full one when the class is not under the id. */
internal val AppIdentity.selfArmAccessibilityServiceShort: String
    get() = shortGlassesComponent(RokidBusAccessibilityService::class.java.name)
