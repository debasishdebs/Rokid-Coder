package com.anezium.rokidbus.plugin.agents

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import com.anezium.rokidbus.plugin.agents.service.CoderAppLifecycle

/** The phone app's process: every app foreground starts or promotes the one service. */
class RokidCoderApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ProcessLifecycleOwner.get().lifecycle.addObserver(CoderAppLifecycle.observer(this))
    }
}
