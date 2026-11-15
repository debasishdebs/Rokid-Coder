package com.anezium.rokidbus.glasses.app

import android.app.Application
import com.anezium.rokidbus.glasses.GlassesCoreConfig
import com.anezium.rokidbus.shared.AppIdentity

/** Rokid Coder on the glasses: the core with our application-id pair. */
class RokidCoderGlassesApplication : Application(), GlassesCoreConfig.Host {
    override val glassesCoreConfig = GlassesCoreConfig(
        AppIdentity(
            phoneApplicationId = BuildConfig.PHONE_APPLICATION_ID,
            glassesApplicationId = BuildConfig.GLASSES_APPLICATION_ID,
        ),
    )
}
