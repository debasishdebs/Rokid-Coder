package com.anezium.rokidbus.plugin.agents.service

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Turns the platform's default-network events into "the default network changed". The first network
 * reported is the one already in use, not a change; one that replaces another, or that arrives after the
 * default was lost, is. Changes closer together than [debounceMs] count once, since a network that comes
 * up often reports a few times in a row. Runs on [scope]'s thread.
 */
internal class DefaultNetworkChanges(
    private val scope: CoroutineScope,
    private val debounceMs: Long = DEBOUNCE_MS,
    private val onChange: () -> Unit,
) {
    private var known = false
    private var current: Any? = null
    private var pending: Job? = null

    fun onAvailable(network: Any) {
        val changed = known && network != current
        known = true
        current = network
        if (!changed) return
        pending?.cancel()
        pending = scope.launch {
            delay(debounceMs)
            onChange()
        }
    }

    fun onLost(network: Any) {
        if (network == current) current = null
    }

    fun stop() {
        pending?.cancel()
        pending = null
    }

    companion object {
        const val DEBOUNCE_MS = 750L
    }
}

/** Registers [changes] for the system's default network. Needs ACCESS_NETWORK_STATE; without it nothing is watched. */
internal class DefaultNetworkWatcher(context: Context, private val changes: DefaultNetworkChanges) {
    private val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    fun start() {
        if (callback != null) return
        val registered = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = changes.onAvailable(network)
            override fun onLost(network: Network) = changes.onLost(network)
        }
        runCatching { manager?.registerDefaultNetworkCallback(registered) }
            .onSuccess { callback = registered }
            .onFailure { Log.w(TAG, "Default network watch refused type=${it.javaClass.simpleName}") }
    }

    fun stop() {
        callback?.let { runCatching { manager?.unregisterNetworkCallback(it) } }
        callback = null
        changes.stop()
    }

    private companion object {
        const val TAG = "DefaultNetworkWatcher"
    }
}
