package com.anezium.rokidbus.plugin.agents.service

import android.app.Activity
import androidx.annotation.MainThread
import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentSession
import com.anezium.rokidbus.plugin.agents.ApprovalDecision
import com.anezium.rokidbus.plugin.agents.PairLineTarget
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the running service does for the rest of the app: the former monitor service's intents, as calls. Main thread. */
interface CoderCommands {
    fun reconcile()

    /** The wearer opened a conversation on the HUD: ask the daemon for it. */
    fun openDetail(session: AgentSession)
    fun closeDetail()

    /** The wearer answered a held tool call on the glasses. */
    fun decideApproval(requestId: String, decision: ApprovalDecision)

    /** The wearer typed a reply into a session's terminal on the glasses. */
    fun sendSessionInput(requestId: String, sessionId: String, text: String)

    /** A prebuilt protocol v2 frame line, from the AgentdProtocolCodec builders. */
    fun sendV2(frame: String)

    /** The wearer is browsing a linked computer's folders in the picker. */
    fun requestFolders(requestId: String, path: String?)

    /** The wearer asked for a new session inside an anchored project. */
    fun requestThreadStart(requestId: String, provider: AgentProvider, path: String, prompt: String)

    /** One pairing, both transports: its trust and outbound slot go, and a live link to it drops. */
    fun forgetMachine(machineId: String)

    /** A v2 pairing line: dial agentd's wss there for a SAS session. */
    fun pairWithLine(target: PairLineTarget)

    /** The wearer changed an alert setting: tell agentd now, if a secure link is up. */
    fun pushSettings()
    fun testLink(provider: AgentProvider)
}

/**
 * The in-process handle on [CoderService]. Code inside the service calls it directly; an activity
 * goes through [fromActivity], which starts the service first when it is not running. Nothing in
 * the app starts the service any other way.
 */
object CoderRuntime : CoderCommands {
    private val _ready = MutableStateFlow(false)

    /** True while the service is up with the hub core started. */
    val ready: StateFlow<Boolean> = _ready.asStateFlow()

    @Volatile private var target: CoderCommands? = null
    private val pending = ArrayDeque<CoderRuntime.() -> Unit>()

    private val _linkState = MutableStateFlow(0)

    /** The glasses link's [com.anezium.rokidbus.shared.LinkStateBits], as the core last reported them. */
    val linkState: StateFlow<Int> = _linkState.asStateFlow()

    /** The running service's glasses core, or null while it is down. */
    @Volatile internal var core: CoderCore? = null
        private set

    @MainThread
    internal fun attachCore(core: CoderCore?) {
        this.core = core
        if (core == null) _linkState.value = 0
    }

    internal fun publishLinkState(state: Int) {
        _linkState.value = state
    }

    /**
     * Runs [command] now if the service is up; otherwise starts it from this visible activity and
     * runs the command once it is. A start Android would not allow drops the command.
     */
    @MainThread
    fun fromActivity(activity: Activity, command: CoderRuntime.() -> Unit) {
        if (target != null) {
            command()
            return
        }
        if (CoderService.startFromForeground(activity)) pending += command
    }

    @MainThread
    internal fun attach(commands: CoderCommands) {
        target = commands
        _ready.value = true
        while (target === commands) {
            val next = pending.removeFirstOrNull() ?: break
            next()
        }
    }

    @MainThread
    internal fun detach(commands: CoderCommands) {
        if (target !== commands) return
        target = null
        _ready.value = false
    }

    /** Tests only: no service, no queued command. */
    @MainThread
    internal fun reset() {
        target = null
        pending.clear()
        _ready.value = false
        attachCore(null)
    }

    override fun reconcile() {
        target?.reconcile()
    }

    override fun openDetail(session: AgentSession) {
        target?.openDetail(session)
    }

    override fun closeDetail() {
        target?.closeDetail()
    }

    override fun decideApproval(requestId: String, decision: ApprovalDecision) {
        target?.decideApproval(requestId, decision)
    }

    override fun sendSessionInput(requestId: String, sessionId: String, text: String) {
        target?.sendSessionInput(requestId, sessionId, text)
    }

    override fun sendV2(frame: String) {
        target?.sendV2(frame)
    }

    override fun requestFolders(requestId: String, path: String?) {
        target?.requestFolders(requestId, path)
    }

    override fun requestThreadStart(requestId: String, provider: AgentProvider, path: String, prompt: String) {
        target?.requestThreadStart(requestId, provider, path, prompt)
    }

    override fun forgetMachine(machineId: String) {
        target?.forgetMachine(machineId)
    }

    override fun pairWithLine(target: PairLineTarget) {
        this.target?.pairWithLine(target)
    }

    override fun pushSettings() {
        target?.pushSettings()
    }

    override fun testLink(provider: AgentProvider) {
        target?.testLink(provider)
    }
}
