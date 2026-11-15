package com.anezium.rokidbus.plugin.agents.service

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/**
 * The process coming to the foreground starts or promotes the service, the notification's tap
 * included. Screen changes inside the app are not a process start: a step that needs the
 * service calls [CoderService.startFromForeground] itself and awaits [CoderRuntime.ready].
 */
object CoderAppLifecycle {
    /** Whether an app foreground may start the service; onboarding narrows it. */
    @Volatile var autoStartAllowed: () -> Boolean = { true }

    fun observer(context: Context): DefaultLifecycleObserver {
        val appContext = context.applicationContext
        return object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                if (autoStartAllowed()) CoderService.startFromForeground(appContext)
            }
        }
    }
}
