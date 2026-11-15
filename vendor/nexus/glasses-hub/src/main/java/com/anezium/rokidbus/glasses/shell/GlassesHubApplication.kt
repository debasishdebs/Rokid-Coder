package com.anezium.rokidbus.glasses.shell

import android.app.Application
import com.anezium.rokidbus.glasses.GlassesCoreConfig
import com.anezium.rokidbus.shared.AppIdentity

/** Upstream Nexus's glasses hub: the core with upstream's application-id pair. */
class GlassesHubApplication : Application(), GlassesCoreConfig.Host {
    override val glassesCoreConfig = GlassesCoreConfig(
        AppIdentity(
            phoneApplicationId = BuildConfig.PHONE_APPLICATION_ID,
            glassesApplicationId = BuildConfig.GLASSES_APPLICATION_ID,
        ),
    )
}
