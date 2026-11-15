package com.anezium.rokidbus.glasses

import android.content.Context
import com.anezium.rokidbus.client.HubTarget
import com.anezium.rokidbus.shared.AppIdentity

/**
 * How a shell sets up the glasses core. Android builds the core's components itself, so the
 * shell's Application hands this over by implementing [Host].
 */
class GlassesCoreConfig(
    /** The shell's own glasses application id and the phone app it pairs with. */
    val identity: AppIdentity,
) {
    /** The glasses hub that this app's own bus clients bind: its BusHubService, under its id. */
    val hubTarget: HubTarget
        get() = HubTarget(identity.glassesApplicationId, BusHubService::class.java.name)

    /** Implemented by every glasses shell's Application. */
    interface Host {
        val glassesCoreConfig: GlassesCoreConfig
    }

    companion object {
        fun of(context: Context): GlassesCoreConfig =
            (context.applicationContext as? Host)?.glassesCoreConfig
                ?: throw IllegalStateException("The glasses app's Application must implement GlassesCoreConfig.Host")
    }
}
