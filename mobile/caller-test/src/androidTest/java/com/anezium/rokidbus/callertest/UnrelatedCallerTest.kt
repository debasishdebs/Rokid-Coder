package com.anezium.rokidbus.callertest

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs in this unrelated app's process, signed with its own key: every service the phone app
 * declares must refuse it. The phone app must be installed first; a missing one fails, never passes.
 */
@RunWith(AndroidJUnit4::class)
class UnrelatedCallerTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val target = BuildConfig.TARGET_PACKAGE

    @Test
    fun unrelated_apk_cannot_bind_or_start_our_services() {
        val packages = context.packageManager
        val services = packages.getPackageInfo(
            target,
            PackageManager.PackageInfoFlags.of(PackageManager.GET_SERVICES.toLong()),
        ).services.orEmpty()
        assertTrue("$target declares no service this test can see", services.isNotEmpty())
        assertNotEquals(
            "this caller must not share the phone app's signing key",
            PackageManager.SIGNATURE_MATCH,
            packages.checkSignatures(target, context.packageName),
        )

        val reached = mutableListOf<String>()
        for (service in services) {
            val component = ComponentName(target, service.name)
            if (bound(component)) reached += "bind ${service.name}"
            if (started(component) { context.startService(it) }) reached += "start ${service.name}"
            if (started(component) { context.startForegroundService(it) }) reached += "startForeground ${service.name}"
        }
        assertEquals("an unrelated app reached the phone app's services", emptyList<String>(), reached)
    }

    /** True only if the system accepted the bind; a refusal is a SecurityException or `false`. */
    private fun bound(component: ComponentName): Boolean {
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) = Unit
            override fun onServiceDisconnected(name: ComponentName?) = Unit
        }
        val accepted = try {
            context.bindService(Intent().setComponent(component), connection, Context.BIND_AUTO_CREATE)
        } catch (_: SecurityException) {
            false
        }
        if (accepted) context.unbindService(connection)
        return accepted
    }

    /**
     * True only if the system started it. A refusal is a SecurityException or a null component;
     * any other exception (a background-start limit) says nothing about the guard, so it fails the test.
     */
    private fun started(component: ComponentName, start: (Intent) -> ComponentName?): Boolean {
        val intent = Intent().setComponent(component)
        val started = try {
            start(intent)
        } catch (_: SecurityException) {
            null
        }
        if (started != null) context.stopService(intent)
        return started != null
    }
}
