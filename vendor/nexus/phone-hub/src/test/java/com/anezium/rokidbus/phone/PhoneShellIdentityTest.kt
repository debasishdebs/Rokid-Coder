package com.anezium.rokidbus.phone

import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.ServiceInfo
import com.anezium.rokidbus.client.HubTarget
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.GlassesClasses
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PhoneShellIdentityTest {
    private val upstream = AppIdentity("com.anezium.rokidbus.phone", "com.anezium.rokidbus.glasses")
    private val ours = AppIdentity("io.github.debasishdebs.rokidcoder", "io.github.debasishdebs.rokidcoder.glasses")

    @Test
    fun each_shell_targets_its_own_pair() {
        assertEquals(upstream, shellIdentity)
        val hub = Robolectric.buildService(BusHubService::class.java).get()
        assertEquals(upstream, hub.core.identity)
        assertEquals("com.anezium.rokidbus.phone.permission.INTERNAL_CORE_CONTROL", INTERNAL_CORE_PERMISSION)
        assertEquals(
            listOf(
                "/sdcard/Android/data/com.anezium.rokidbus.glasses/files/cmd_bridge/manual_selfarm/watchdog.sh",
                "/sdcard/Android/data/com.anezium.rokidbus.glasses/files/cmd_bridge/manual_selfarm/bridge.sh",
            ),
            GlassesManualArmRunner.stagedScriptPaths(shellIdentity),
        )
        assertEquals(
            listOf(
                "/sdcard/Android/data/io.github.debasishdebs.rokidcoder.glasses/files/cmd_bridge/manual_selfarm/watchdog.sh",
                "/sdcard/Android/data/io.github.debasishdebs.rokidcoder.glasses/files/cmd_bridge/manual_selfarm/bridge.sh",
            ),
            GlassesManualArmRunner.stagedScriptPaths(ours),
        )
    }

    @Test
    fun every_built_component_resolves_to_a_real_class() {
        // This suite runs without Android resources, so Robolectric's package manager does not
        // know the app; install what the merged manifest ships and resolve through it.
        val manifest = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder()
            .parse(File(System.getProperty("rokid.mergedManifest")))
            .documentElement
        val packageName = manifest.getAttribute("package")
        assertEquals(shellIdentity.phoneApplicationId, packageName)
        val context = RuntimeEnvironment.getApplication()
        val packageManager = shadowOf(context.packageManager)
        val pkg = PackageInfo().apply {
            this.packageName = packageName
            applicationInfo = ApplicationInfo().apply { this.packageName = packageName }
        }
        packageManager.installPackage(pkg)
        for (name in manifest.androidNames("service")) {
            packageManager.addOrUpdateService(ServiceInfo().apply { this.packageName = packageName; this.name = name })
        }
        val permissions = manifest.androidNames("permission")

        val hubService = shellIdentity.phoneComponent(BusHubService::class.java.name)
        assertEquals(HubTarget.PHONE.packageName, hubService.packageName)
        assertEquals(HubTarget.PHONE.serviceClassName, hubService.className)
        assertEquals(hubService.className, context.packageManager.getServiceInfo(hubService, 0).name)
        Class.forName(hubService.className)
        assertTrue(INTERNAL_CORE_PERMISSION in permissions)
    }

    private fun Element.androidNames(tag: String): List<String> {
        val nodes = getElementsByTagName(tag)
        return (0 until nodes.length).map {
            (nodes.item(it) as Element).getAttributeNS("http://schemas.android.com/apk/res/android", "name")
        }
    }

    @Test
    fun generated_scripts_and_commands_target_identity_ids() {
        val commands = listOf(
            GlassesManualArmCommand.buildPrepare(ours, "#!/system/bin/sh\n", "#!/system/bin/sh\n"),
            GlassesManualArmCommand.buildArm(ours, restartWatchdog = false),
            GlassesManualArmCommand.buildArm(ours, restartWatchdog = true),
        )
        for (command in commands) {
            assertTrue(command.contains("PKG='io.github.debasishdebs.rokidcoder.glasses'\n"))
            assertTrue(
                command.contains(
                    "SVC='io.github.debasishdebs.rokidcoder.glasses/${GlassesClasses.ACCESSIBILITY_SERVICE}'\n",
                ),
            )
            // Our application id is not the class namespace, so the short form is the full one.
            assertTrue(
                command.contains(
                    "SVC_SHORT='io.github.debasishdebs.rokidcoder.glasses/${GlassesClasses.ACCESSIBILITY_SERVICE}'\n",
                ),
            )
            assertFalse(command.contains("com.anezium.rokidbus.glasses'"))
            assertFalse(command.contains("com.anezium.rokidbus.glasses/"))
        }
        assertTrue(
            GlassesManualArmCommand.buildArm(upstream, restartWatchdog = true)
                .contains("SVC_SHORT='com.anezium.rokidbus.glasses/.RokidBusAccessibilityService'\n"),
        )
    }
}
