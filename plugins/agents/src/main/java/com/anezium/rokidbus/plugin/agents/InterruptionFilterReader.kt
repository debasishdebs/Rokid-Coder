package com.anezium.rokidbus.plugin.agents

import android.app.NotificationManager
import android.content.Context

/**
 * Reads the phone's Do Not Disturb. No permission is needed to read the
 * interruption filter. It is read afresh on every call, never cached, since
 * the spoken cue checks it right before playing (R37).
 */
class InterruptionFilterReader(private val context: Context) {
    fun read(): DndState = try {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager == null) DndState.UNKNOWN else classify(manager.currentInterruptionFilter)
    } catch (_: RuntimeException) {
        DndState.UNKNOWN
    }

    companion object {
        /** Priority-only and alarms-only still hold an alert back: only `ALL` is an open phone. */
        fun classify(filter: Int): DndState = when (filter) {
            NotificationManager.INTERRUPTION_FILTER_ALL -> DndState.OFF
            NotificationManager.INTERRUPTION_FILTER_NONE,
            NotificationManager.INTERRUPTION_FILTER_PRIORITY,
            NotificationManager.INTERRUPTION_FILTER_ALARMS,
            -> DndState.ON
            else -> DndState.UNKNOWN
        }
    }
}
