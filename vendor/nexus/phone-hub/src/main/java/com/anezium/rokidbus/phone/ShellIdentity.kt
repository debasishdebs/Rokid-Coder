package com.anezium.rokidbus.phone

import com.anezium.rokidbus.shared.AppIdentity

/** This shell's application-id pair, from its build: upstream Nexus's phone and glasses hubs. */
internal val shellIdentity = AppIdentity(
    phoneApplicationId = BuildConfig.PHONE_APPLICATION_ID,
    glassesApplicationId = BuildConfig.GLASSES_APPLICATION_ID,
)
