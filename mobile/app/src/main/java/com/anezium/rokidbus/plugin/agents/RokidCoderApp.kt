package com.anezium.rokidbus.plugin.agents

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import com.anezium.rokidbus.plugin.agents.onboarding.OnboardingStore
import com.anezium.rokidbus.plugin.agents.service.CoderAppLifecycle

/** The phone app's process: every app foreground starts or promotes the one service. */
class RokidCoderApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Nothing starts in the background before onboarding asked for the permissions it runs under.
        CoderAppLifecycle.autoStartAllowed = { OnboardingStore(this).serviceAllowed() }
        ProcessLifecycleOwner.get().lifecycle.addObserver(CoderAppLifecycle.observer(this))
    }
}
