package com.anezium.rokidbus.glasses

import android.app.Application
import com.anezium.rokidbus.shared.AppIdentity

/** The upstream shells' pair. */
internal val UPSTREAM_PAIR = AppIdentity("com.anezium.rokidbus.phone", "com.anezium.rokidbus.glasses")

/** Rokid Coder's pair. */
internal val ROKID_CODER_PAIR = AppIdentity("io.github.debasishdebs.rokidcoder", "io.github.debasishdebs.rokidcoder.glasses")

/** The Robolectric application of this suite (robolectric.properties): a shell with the upstream pair. */
class UpstreamGlassesTestApplication : Application(), GlassesCoreConfig.Host {
    override val glassesCoreConfig = GlassesCoreConfig(UPSTREAM_PAIR)
}
