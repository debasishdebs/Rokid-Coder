package com.anezium.rokidbus.plugin.agents.service

import android.app.Notification
import android.app.Service
import androidx.core.app.ServiceCompat

/** The platform's `startForeground`, the one seam tests replace. */
fun interface ForegroundStarter {
    fun start(id: Int, notification: Notification, types: Int)

    companion object {
        fun of(service: Service) = ForegroundStarter { id, notification, types ->
            ServiceCompat.startForeground(service, id, notification, types)
        }
    }
}
