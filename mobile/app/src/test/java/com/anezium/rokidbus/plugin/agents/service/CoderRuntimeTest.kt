package com.anezium.rokidbus.plugin.agents.service

import android.app.Activity
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import com.anezium.rokidbus.plugin.agents.AddComputerActivity
import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentSession
import com.anezium.rokidbus.plugin.agents.AgentStatus
import com.anezium.rokidbus.plugin.agents.AgentsConfigStore
import com.anezium.rokidbus.plugin.agents.AgentsCore
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import com.anezium.rokidbus.plugin.agents.AgentsSettingsActivity
import com.anezium.rokidbus.plugin.agents.ComputerActivity
import com.anezium.rokidbus.plugin.agents.FakeGlassesSurface
import com.anezium.rokidbus.plugin.agents.FixturePhoneTlsIdentity
import com.anezium.rokidbus.plugin.agents.LinkMachine
import com.anezium.rokidbus.plugin.agents.NewThreadActivity
import com.anezium.rokidbus.plugin.agents.ProjectPickerActivity
import com.anezium.rokidbus.plugin.agents.openGuidedDoor
import com.anezium.rokidbus.plugin.agents.ui.SettingsActions
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper
import java.io.File

/** Every former AgentsMonitorService caller reaches the running service through [CoderRuntime]. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CoderRuntimeTest {
    private val app = RuntimeEnvironment.getApplication()
    private val service = RecordingCommands()

    @Before
    fun setUp() {
        CoderRuntime.reset()
        CoderService.processStarted = { true }
        CoderRuntime.attach(service)
    }

    @After
    fun tearDown() {
        CoderRuntime.reset()
        CoderService.resetSeams()
        AgentsRuntime.store.setLinkMachine(null)
        AgentsRuntime.hudOpen = false
    }

    private fun idle() = ShadowLooper.idleMainLooper()

    private fun views(root: View): List<View> =
        listOf(root) + ((root as? ViewGroup)?.let { group -> (0 until group.childCount).flatMap { views(group.getChildAt(it)) } } ?: emptyList())

    private fun Activity.click(label: String) {
        // Outline buttons show their label in capitals.
        val view = views(window.decorView).first { it.isShown && (it as? TextView)?.text?.toString().equals(label, ignoreCase = true) }
        assertTrue("$label is not clickable", view.performClick())
        idle()
    }

    private fun <T> Any.call(name: String, vararg args: Any?): T {
        val method = javaClass.declaredMethods.first { it.name == name && it.parameterCount == args.size }
        method.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return method.invoke(this, *args) as T
    }

    private fun machine(intent: Intent) =
        intent.putExtra(ComputerActivity.EXTRA_MACHINE_ID, "m1").putExtra(ComputerActivity.EXTRA_MACHINE_NAME, "Desk")

    @Test
    fun activity_commands_start_the_service_when_stopped_then_run() {
        CoderRuntime.reset()
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()

        CoderRuntime.fromActivity(activity) { requestFolders("r1", "/src") }

        // Not running: the activity starts it, and the command waits for it.
        assertEquals(CoderService.ACTION_FOREGROUND_START, shadowOf(app).nextStartedService.action)
        assertTrue(service.calls.isEmpty())
        assertFalse(CoderRuntime.ready.value)

        CoderRuntime.attach(service)

        assertTrue(CoderRuntime.ready.value)
        assertEquals(listOf("requestFolders(r1, /src)"), service.calls)

        // Running: the next one goes at once, and starts nothing.
        CoderRuntime.fromActivity(activity) { closeDetail() }
        assertEquals("closeDetail", service.calls.last())
        assertEquals(null, shadowOf(app).nextStartedService)
    }

    @Test
    fun a_command_android_would_not_start_for_is_dropped() {
        CoderRuntime.reset()
        CoderService.processStarted = { false }
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()

        CoderRuntime.fromActivity(activity) { reconcile() }
        CoderRuntime.attach(service)

        assertTrue(service.calls.isEmpty())
    }

    @Test
    fun every_former_monitor_caller_reaches_coder_runtime_settings() {
        AgentsConfigStore(app).setAgentdEnabled(true)
        val activity = Robolectric.buildActivity(AgentsSettingsActivity::class.java).setup().get()
        idle()
        assertEquals("onCreate reconciles while monitoring", listOf("reconcile"), service.calls)
        service.calls.clear()

        val actions: SettingsActions = activity.call("actions")
        actions.onMonitoring(false)
        actions.onForgetPaired()
        actions.onPairingTtl(7)
        actions.onRevokeAll()
        actions.onAlerts { this }
        idle()

        assertEquals(listOf("reconcile", "reconcile", "pushSettings"), service.calls.take(3))
        // The TTL reconciles only while monitoring, which the switch just turned off.
        assertTrue(service.calls[3], service.calls[3].startsWith("sendV2({"))
        assertEquals("pushSettings", service.calls[4])
        assertEquals(5, service.calls.size)
    }

    @Test
    fun every_former_monitor_caller_reaches_coder_runtime_project_picker() {
        AgentsRuntime.store.setLinkMachine(LinkMachine("m1", "Desk", overTailnet = false))

        Robolectric.buildActivity(ProjectPickerActivity::class.java, machine(Intent(app, ProjectPickerActivity::class.java))).setup()
        idle()

        assertEquals(1, service.calls.size)
        assertTrue(service.calls.single(), Regex("requestFolders\\([0-9a-f-]{36}, null\\)").matches(service.calls.single()))
    }

    @Test
    fun every_former_monitor_caller_reaches_coder_runtime_computer() {
        val activity = Robolectric.buildActivity(ComputerActivity::class.java, machine(Intent(app, ComputerActivity::class.java))).setup().get()

        activity.click("Forget this computer")

        assertEquals(listOf("forgetMachine(m1)"), service.calls)
    }

    @Test
    fun every_former_monitor_caller_reaches_coder_runtime_new_thread() {
        AgentsRuntime.store.setLinkMachine(LinkMachine("m1", "Desk", overTailnet = false))
        val intent = machine(Intent(app, NewThreadActivity::class.java))
            .putExtra(NewThreadActivity.EXTRA_PROJECT_NAME, "api")
            .putExtra(NewThreadActivity.EXTRA_PROJECT_PATH, "/src/api")
        val activity = Robolectric.buildActivity(NewThreadActivity::class.java, intent).setup().get()
        views(activity.window.decorView).filterIsInstance<EditText>().first().setText("fix the build")

        activity.click("Start with Codex")

        assertEquals(1, service.calls.size)
        assertTrue(
            service.calls.single(),
            Regex("requestThreadStart\\([0-9a-f-]{36}, codex, /src/api, fix the build\\)").matches(service.calls.single()),
        )
    }

    @Test
    fun every_former_monitor_caller_reaches_coder_runtime_add_computer() {
        val activity = Robolectric.buildActivity(AddComputerActivity::class.java).setup().get()

        activity.click(views(activity.window.decorView).filterIsInstance<TextView>()
            .first { it.text.toString().endsWith("Open the door for two minutes") }.text.toString())
        activity.click("Cancel")
        val line = """{"v":2,"kind":"rokid-coder","host":"desk","port":8792,"fp":"${FixturePhoneTlsIdentity.FINGERPRINT}"}"""
        views(activity.window.decorView).filterIsInstance<EditText>().forEach { it.setText(line) }
        activity.click("Pair")

        assertEquals(listOf("reconcile", "reconcile", "pairWithLine(desk, 8792)"), service.calls)
    }

    @Test
    fun every_former_monitor_caller_reaches_coder_runtime_guided_pairing() {
        openGuidedDoor(AgentsConfigStore(app))

        assertEquals(listOf("reconcile"), service.calls)
    }

    @Test
    fun every_former_monitor_caller_reaches_coder_runtime_agents_core() {
        AgentsConfigStore(app).setAgentdEnabled(true)
        val glasses = FakeGlassesSurface()
        val core = AgentsCore(glasses, app).also(AgentsCore::start)
        idle()
        try {
            glasses.open()
            idle()
            assertEquals("an open reconciles while monitoring", listOf("reconcile"), service.calls)

            val session = AgentSession(id = "s1", provider = AgentProvider.CLAUDE, status = AgentStatus.WORKING)
            core.call<Unit>("openConversation", session)
            core.call<Unit>("leaveConversation")

            assertEquals(listOf("reconcile", "openDetail(s1)", "closeDetail"), service.calls)
        } finally {
            core.close()
            idle()
        }
    }

    @Test
    fun no_service_start_outside_coder_service() {
        val main = File("src/main/java")
        val offenders = main.walkTopDown()
            .filter { it.isFile && it.extension == "kt" && "/service/" !in it.invariantSeparatorsPath }
            .filter { file -> file.readText().let { "startService(" in it || "startForegroundService(" in it } }
            .map { it.relativeTo(main).invariantSeparatorsPath }
            .toList()
        assertTrue("the source tree is where this test thinks", File(main, "com/anezium/rokidbus/plugin/agents/service/CoderService.kt").isFile)
        assertEquals(emptyList<String>(), offenders)
    }
}
