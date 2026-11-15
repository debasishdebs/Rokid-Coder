@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import android.content.Intent
import com.anezium.rokidbus.client.HubTarget
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** The upstream phone shell, now a Service over :phone-core (adr-cores.md §2, §6). */
@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [32])
class UpstreamShellOnCoreTest {
    private val hub = Robolectric.buildService(BusHubService::class.java).get()

    @Test
    fun upstream_shells_build_and_pass_on_the_cores() {
        // The application id and the hub component every plugin binds are unchanged.
        val build = File("build.gradle.kts").readText()
        assertTrue(build.contains("applicationId = \"com.anezium.rokidbus.phone\""))
        assertTrue(build.contains("implementation(project(\":phone-core\"))"))
        assertEquals("com.anezium.rokidbus.phone", HubTarget.PHONE.packageName)
        assertEquals(BusHubService::class.java.name, HubTarget.PHONE.serviceClassName)
        val services = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(File("src/main/AndroidManifest.xml")).getElementsByTagName("service")
        assertTrue((0 until services.length).any {
            services.item(it).attributes.getNamedItem("android:name")?.nodeValue == ".BusHubService"
        })
        // The shell's bus is the core's.
        assertTrue(hub.onBind(Intent()) === hub.core.busBinder())
    }

    @Test
    fun shell_reads_the_gate_and_never_writes_it() {
        assertTrue(BusHubService::class.java.declaredFields.none { it.name == "hubEnabled" })
        shadowOf(hub.application).grantPermissions(android.Manifest.permission.BLUETOOTH_CONNECT)
        val loop = HubCore::class.java.getDeclaredField("sppLoopStarted").apply { isAccessible = true }
        (loop.get(hub.core) as java.util.concurrent.atomic.AtomicBoolean).set(true)
        assertFalse(hub.core.isEnabled)
        hub.onStartCommand(HubCommandIntents.create(hub), 0, 1)
        assertTrue(hub.core.isEnabled)
        hub.onStartCommand(HubCommandIntents.create(hub).setAction("com.anezium.rokidbus.phone.STOP"), 0, 2)
        assertFalse(hub.core.isEnabled)
        assertFalse(BusHubService.isEnabled(hub))
    }
}
