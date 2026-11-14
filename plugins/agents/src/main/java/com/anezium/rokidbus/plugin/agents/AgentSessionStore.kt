package com.anezium.rokidbus.plugin.agents

import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.concurrent.CopyOnWriteArrayList

data class LinkMachine(
    val machineId: String,
    val machineName: String,
    val overTailnet: Boolean,
)

private const val MAX_NOT_APPLIED = 32
private const val NOT_APPLIED_MS = 30_000L

/** Open only so a test can hold a connection write mid-flight; nothing here is meant to be overridden. */
open class AgentSessionStore {
    private val providerSessions = AgentProvider.values().associateWith {
        linkedMapOf<String, AgentSession>()
    }.toMutableMap()
    private val _sessions = MutableStateFlow<List<AgentSession>>(emptyList())
    private val _connections = MutableStateFlow(
        AgentProvider.values().associateWith { ProviderConnectionState() },
    )

    private val _conversation = MutableStateFlow<AgentConversation?>(null)
    private val _approvals = MutableStateFlow<List<AgentApproval>>(emptyList())
    private val _linkMachine = MutableStateFlow<LinkMachine?>(null)

    val approvals: StateFlow<List<AgentApproval>> = _approvals.asStateFlow()
    val sessions: StateFlow<List<AgentSession>> = _sessions.asStateFlow()

    private val departureListeners = CopyOnWriteArrayList<(String) -> Unit>()

    /**
     * Calls [listener] with the key of each session that left for good: one agentd reported removed
     * over a live link, or one its own machine's snapshot omits. A board emptied because monitoring
     * stopped or a link dropped says nothing of the laptop's sessions, and is not announced. Called
     * on the transport's thread, never under the store's lock, and never dropped: a departure nobody
     * listens to is kept and announced on its machine's next snapshot. Returns the call that stops it.
     */
    fun onSessionDeparted(listener: (String) -> Unit): () -> Unit {
        departureListeners += listener
        return { departureListeners -= listener }
    }
    val connections: StateFlow<Map<AgentProvider, ProviderConnectionState>> =
        _connections.asStateFlow()
    val conversation: StateFlow<AgentConversation?> = _conversation.asStateFlow()

    /** The machine currently holding the LAN link, if any. */
    val linkMachine: StateFlow<LinkMachine?> = _linkMachine.asStateFlow()

    fun setLinkMachine(machine: LinkMachine?) {
        _linkMachine.value = machine
    }

    private val _fsListing = MutableStateFlow<FsListing?>(null)

    /** The latest folder listing the daemon answered; matched by request id. */
    val fsListing: StateFlow<FsListing?> = _fsListing.asStateFlow()

    fun setFsListing(listing: FsListing) {
        _fsListing.value = listing
    }

    private val _threadStart = MutableStateFlow<ThreadStartResult?>(null)

    /** The latest spawn verdict the daemon answered; matched by request id. */
    val threadStart: StateFlow<ThreadStartResult?> = _threadStart.asStateFlow()

    fun setThreadStart(result: ThreadStartResult) {
        _threadStart.value = result
    }

    private val _sessionInputResult = MutableStateFlow<SessionInputResult?>(null)

    /** The latest typed-reply verdict the daemon answered; matched by request id. */
    val sessionInputResult: StateFlow<SessionInputResult?> = _sessionInputResult.asStateFlow()

    fun setSessionInputResult(result: SessionInputResult) {
        _sessionInputResult.value = result
    }

    @Synchronized
    fun openConversation(session: AgentSession) {
        _conversation.value = AgentConversation(
            sessionKey = session.key,
            sessionId = session.id,
            provider = session.provider,
        )
    }

    @Synchronized
    fun closeConversation() {
        _conversation.value = null
    }

    @Synchronized
    fun setConversation(
        provider: AgentProvider,
        sessionId: String,
        messages: List<AgentMessage>,
    ) {
        val current = _conversation.value ?: return
        // A late reply for a conversation the wearer already left must not reopen it.
        if (current.provider != provider || current.sessionId != sessionId) return
        _conversation.value = current.copy(
            loading = false,
            messages = messages.takeLast(AgentConversation.MAX_MESSAGES),
        )
    }

    @Synchronized
    fun appendConversation(
        provider: AgentProvider,
        sessionId: String,
        message: AgentMessage,
    ) {
        val current = _conversation.value ?: return
        if (current.provider != provider || current.sessionId != sessionId) return
        _conversation.value = current.copy(
            loading = false,
            messages = (current.messages + message).takeLast(AgentConversation.MAX_MESSAGES),
        )
    }

    @Synchronized
    fun replaceProvider(
        provider: AgentProvider,
        sessions: List<AgentSession>,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val replacement = linkedMapOf<String, AgentSession>()
        sessions.filter { it.provider == provider }.forEach { replacement[it.id] = it }
        providerSessions[provider] = replacement
        publish(nowMs)
    }

    /** A `session_removed` agentd sent for [sessionKey], over a live link from [machineId]. */
    data class SessionRemoval(val sessionKey: String, val machineId: String)

    private class Owner(val machineId: String, val provider: AgentProvider)

    /**
     * The machine that first reported each session, by key. It outlives the
     * session on the board, a pruned one included: a launcher id kept for a
     * session is bound to it, and only that machine's snapshot can say the
     * session is gone. It goes once that departure was announced.
     */
    private val owners = LinkedHashMap<String, Owner>()

    private val removalListeners = CopyOnWriteArrayList<(SessionRemoval) -> Unit>()

    /** The machine that first reported [sessionKey], or null when no link said. */
    @Synchronized
    fun ownerOf(sessionKey: String): String? = owners[sessionKey]?.machineId

    /**
     * Calls [listener] for every `session_removed` with the machine it came from,
     * on the transport's thread, after the board has dropped the session. Returns
     * the call that stops it.
     */
    fun onSessionRemoved(listener: (SessionRemoval) -> Unit): () -> Unit {
        removalListeners += listener
        return { removalListeners -= listener }
    }

    private fun own(session: AgentSession, machineId: String?) {
        if (machineId == null || session.key in owners) return
        owners[session.key] = Owner(machineId, session.provider)
        while (owners.size > MAX_OWNERS) owners.remove(owners.keys.first())
    }

    /**
     * One snapshot, several harnesses. The daemon link speaks for every provider
     * it monitors, so its snapshot is authoritative for all of them at once —
     * replacing them one at a time would leave a harness the daemon just stopped
     * watching sitting on the board forever.
     *
     * The snapshot also speaks for every session [machineId] ever reported, on
     * the board or pruned from it: one it omits was closed, while the link was
     * down or since, and departs. Another machine's sessions are not its to end.
     */
    fun replaceLinkSessions(
        providers: Set<AgentProvider>,
        sessions: List<AgentSession>,
        machineId: String?,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val departed = synchronized(this) {
            sessions.forEach { own(it, machineId) }
            providers.forEach { provider ->
                val replacement = linkedMapOf<String, AgentSession>()
                sessions.filter { it.provider == provider }.forEach { replacement[it.id] = it }
                providerSessions[provider] = replacement
            }
            sessions.forEach { notApplied.remove(it.key) }
            val present = sessions.mapTo(HashSet()) { it.key }
            val departed = if (machineId == null) {
                emptyList()
            } else {
                owners.filter { (key, owner) ->
                    owner.machineId == machineId && owner.provider in providers && key !in present
                }.keys.toList()
            }
            departed.forEach { key ->
                notApplied.remove(key)
                replyNotSent.remove(key)
            }
            publish(nowMs)
            departed
        }
        departed.forEach { announceDeparture(it, machineId) }
    }

    /**
     * A transport emptied the board: an inbound disconnect, a monitoring stop or
     * a dropped link. That says nothing of the laptop's sessions, so nothing is
     * announced; the machine's next snapshot decides.
     */
    @Synchronized
    fun clearLinkSessions(providers: Set<AgentProvider>, nowMs: Long = System.currentTimeMillis()) {
        providers.forEach { provider -> providerSessions[provider] = linkedMapOf() }
        publish(nowMs)
    }

    /**
     * Tells every listener [key] departed; only once one has heard it does the
     * owner record go, so a departure nobody heard comes again on the next snapshot.
     */
    private fun announceDeparture(key: String, machineId: String?) {
        val listeners = departureListeners.toList()
        if (listeners.isEmpty()) return
        listeners.forEach { it(key) }
        synchronized(this) {
            if (machineId != null && owners[key]?.machineId == machineId) owners.remove(key)
        }
    }

    /**
     * A mode change agentd refused: the menu shows the real mode and this beside
     * it (R101). It lasts until an upsert shows another temporary mode than the
     * one shown when it was refused, or for [NOT_APPLIED_MS] (R107): a busy
     * session's ordinary progress must not erase it. A brief is an extra.
     */
    private class Refusal(val error: String, val tempMode: TempMode?, val atMs: Long)

    private val notApplied = LinkedHashMap<String, Refusal>()

    @Synchronized
    fun noteNotApplied(sessionKey: String, error: String, nowMs: Long = System.currentTimeMillis()) {
        val shown = providerSessions.values.firstNotNullOfOrNull { sessions ->
            sessions.values.firstOrNull { it.key == sessionKey }
        }?.v2?.tempMode
        notApplied.remove(sessionKey)
        notApplied[sessionKey] = Refusal(error, shown, nowMs)
        while (notApplied.size > MAX_NOT_APPLIED) notApplied.remove(notApplied.keys.first())
    }

    @Synchronized
    fun notApplied(sessionKey: String, nowMs: Long = System.currentTimeMillis()): String? {
        val refusal = notApplied[sessionKey] ?: return null
        if (nowMs - refusal.atMs >= NOT_APPLIED_MS) {
            notApplied.remove(sessionKey)
            return null
        }
        return refusal.error
    }

    /**
     * A follow-up agentd rejected, kept with the session until the next follow-up
     * or its `followup_closed` (R106). Unlike [notApplied] a session upsert does
     * not end it: the rejection says nothing about the session's state.
     */
    private val replyNotSent = LinkedHashMap<String, String>()

    @Synchronized
    fun noteReplyNotSent(sessionKey: String, error: String) {
        replyNotSent.remove(sessionKey)
        replyNotSent[sessionKey] = error
        while (replyNotSent.size > MAX_NOT_APPLIED) replyNotSent.remove(replyNotSent.keys.first())
    }

    @Synchronized
    fun replyNotSent(sessionKey: String): String? = replyNotSent[sessionKey]

    @Synchronized
    fun clearReplyNotSent(sessionKey: String) {
        replyNotSent.remove(sessionKey)
    }

    @Synchronized
    fun upsert(session: AgentSession, machineId: String? = null, nowMs: Long = System.currentTimeMillis()) {
        own(session, machineId)
        providerSessions.getValue(session.provider)[session.id] = session
        // Only a mode change ends the refusal of one.
        val refusal = notApplied[session.key]
        if (refusal != null && session.v2?.tempMode != refusal.tempMode) notApplied.remove(session.key)
        publish(nowMs)
    }

    /** agentd's `session_removed`, over a live link from [machineId]. */
    fun remove(
        provider: AgentProvider,
        sessionId: String,
        machineId: String?,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val key = "${provider.wireValue}:$sessionId"
        synchronized(this) {
            providerSessions.getValue(provider).remove(sessionId)
            notApplied.remove(key)
            replyNotSent.remove(key)
            publish(nowMs)
        }
        // Outside the lock: a listener may read the store.
        if (machineId != null) removalListeners.forEach { it(SessionRemoval(key, machineId)) }
        announceDeparture(key, machineId)
    }

    /**
     * Drops what has aged out for good. Hiding an expired session from the
     * published list was never enough: it stayed in [providerSessions] for the
     * lifetime of the process, so a long-lived daemon churning through sessions
     * grew the map forever and made every publish a little slower.
     *
     * Returns the keys that were let go, so callers can forget what they were
     * remembering about them.
     */
    @Synchronized
    fun prune(nowMs: Long = System.currentTimeMillis()): Set<String> {
        val dropped = mutableSetOf<String>()
        providerSessions.values.forEach { sessions ->
            val expired = sessions.values.filter { it.hasExpired(nowMs) }
            expired.forEach { session ->
                sessions.remove(session.id)
                dropped += session.key
            }
        }
        publish(nowMs)
        return dropped
    }

    // ------------------------------------------------------------- approvals

    @Synchronized
    fun upsertApproval(approval: AgentApproval) {
        val without = _approvals.value.filterNot { it.requestId == approval.requestId }
        // Oldest out first: a request nobody answered is the one least likely to
        // still matter, and the wearer should never be handed a stale question.
        _approvals.value = (without + approval).takeLast(AgentApproval.MAX_PENDING)
    }

    @Synchronized
    fun resolveApproval(requestId: String) {
        _approvals.value = _approvals.value.filterNot { it.requestId == requestId }
    }

    /**
     * A provider that went away takes its questions with it: the daemon replays
     * everything still pending once it is back, so keeping them would only offer
     * the wearer decisions that can no longer be delivered.
     */
    @Synchronized
    fun clearApprovals(providers: Set<AgentProvider>) {
        _approvals.value = _approvals.value.filterNot { it.provider in providers }
    }

    fun approvalFor(sessionKey: String): AgentApproval? =
        _approvals.value.firstOrNull { it.sessionKey == sessionKey }

    @Synchronized
    open fun setConnection(
        provider: AgentProvider,
        state: ConnectionState,
        detail: String? = null,
    ) {
        _connections.value = _connections.value.toMutableMap().apply {
            put(provider, ProviderConnectionState(state, detail))
        }
    }

    private fun publish(nowMs: Long) {
        val retained = providerSessions.values
            .asSequence()
            .flatMap { it.values.asSequence() }
            .filterNot { it.hasExpired(nowMs) }
            .sortedWith(SESSION_COMPARATOR)
            .toList()
        _sessions.value = retained
    }

    private fun AgentSession.hasExpired(nowMs: Long): Boolean =
        status == AgentStatus.DONE &&
            lastActivityAt?.let { nowMs >= it && nowMs - it > DONE_RETENTION_MS } == true

    companion object {
        const val DONE_RETENTION_MS = 30 * 60 * 1_000L

        /** Owners remembered, well above the history's 200 entries; the oldest go first. */
        private const val MAX_OWNERS = 1_024

        /**
         * Attention first. A failed session used to sort below idle ones while
         * being rendered in alert and raising a band — the order contradicted
         * everything else the product said about it.
         */
        private val STATUS_RANK = mapOf(
            AgentStatus.NEEDS_YOU to 0,
            AgentStatus.ERROR to 1,
            AgentStatus.WORKING to 2,
            AgentStatus.IDLE to 3,
            AgentStatus.DONE to 4,
        )

        private val SESSION_COMPARATOR = Comparator<AgentSession> { left, right ->
            val rank = STATUS_RANK.getValue(left.status).compareTo(STATUS_RANK.getValue(right.status))
            if (rank != 0) {
                rank
            } else {
                val withinStatus = when (left.status) {
                    AgentStatus.NEEDS_YOU -> compareValues(
                        left.pendingRequest?.createdAt ?: Long.MAX_VALUE,
                        right.pendingRequest?.createdAt ?: Long.MAX_VALUE,
                    )
                    AgentStatus.WORKING,
                    AgentStatus.IDLE,
                    AgentStatus.ERROR,
                    AgentStatus.DONE,
                    -> compareValues(
                        right.lastActivityAt ?: Long.MIN_VALUE,
                        left.lastActivityAt ?: Long.MIN_VALUE,
                    )
                }
                if (withinStatus != 0) {
                    withinStatus
                } else {
                    left.displayTitle.compareTo(right.displayTitle, ignoreCase = true)
                }
            }
        }
    }
}

object AgentsRuntime {
    val store = AgentSessionStore()

    /** The alerts the glasses showed and how each ended; in memory, lost with the process. */
    val history = AlertHistory(System::currentTimeMillis)

    /**
     * True while the hub has the plugin's surface open. The monitor service
     * stops the plugin service when it has nothing left to watch, and doing that
     * under a surface the wearer is reading tears down the bus client outside
     * the hub's own open/close lifecycle.
     */
    @Volatile
    var hudOpen: Boolean = false

    /**
     * The two halves of the alert path meet here. The monitor service owns the
     * [AlertDirector] (R72) and the plugin service owns the bus client, so each
     * registers itself for the other while it is alive.
     */
    private val _alertDirector = MutableStateFlow<AlertDirector?>(null)

    /** Seen as a flow too, so the board can follow the director's `+N waiting` across a monitor restart. */
    internal val alertDirectors: StateFlow<AlertDirector?> = _alertDirector.asStateFlow()

    internal var alertDirector: AlertDirector?
        get() = _alertDirector.value
        set(value) {
            _alertDirector.value = value
        }

    /**
     * A monitor service going away clears the director only if it is still its
     * own (R99): an old instance being destroyed after a newer one started must
     * not wipe the newer one's director.
     */
    internal fun clearAlertDirector(director: AlertDirector): Boolean =
        _alertDirector.compareAndSet(director, null)

    @Volatile
    internal var alertGlasses: AlertGlasses? = null

    private val _linkedMachines = MutableSharedFlow<String>(
        replay = 1,
        extraBufferCapacity = 4,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /**
     * A computer just linked itself for the first time. The connection is owned
     * by the monitor service and the glasses are owned by the plugin service, so
     * this is how the news crosses: replayed once, because the link can land
     * before the plugin service is listening.
     */
    val linkedMachines: SharedFlow<String> = _linkedMachines.asSharedFlow()

    fun announceLinkedMachine(machineName: String) {
        _linkedMachines.tryEmit(machineName)
    }

    private val _needsRepair = MutableStateFlow(false)

    /**
     * True while the dialled pairing stopped at AUTH_FAILED (the client's `needsRepair`): the glasses'
     * board and the phone's Add a computer screen offer to pair again. Fed by the monitor service.
     */
    val needsRepair: StateFlow<Boolean> = _needsRepair.asStateFlow()

    internal fun setNeedsRepair(needed: Boolean) {
        _needsRepair.value = needed
    }

    /** The guided pairing attempt both the phone screen and the glasses card show. */
    internal val guidedPairing: GuidedPairing by lazy { GuidedPairing(clock = SystemClock::elapsedRealtime) }

    /**
     * A transport bound a secure link to a computer. Fed by the secure outbound hello_ack and the
     * secure inbound bind, and nothing else, so only a connection that really steers can end a guided
     * attempt. Stamped on the clock the attempt starts on.
     */
    internal fun announceSecureConnection(machineId: String, name: String) {
        guidedPairing.onSecureConnected(machineId, name, SystemClock.elapsedRealtime())
    }

    private val _linkSecure = MutableStateFlow(false)

    /** True while some transport to agentd is bound as steering-capable. */
    val linkSecure: StateFlow<Boolean> = _linkSecure.asStateFlow()

    internal fun setLinkSecure(secure: Boolean) {
        _linkSecure.value = secure
    }

    /**
     * Link changes and inbound v2 actions, in arrival order. `LinkUp` comes after
     * hello_ack and before the first frame that follows it. Not replayed: a late
     * collector starts from the next link, and reads [link] for the current one.
     *
     * Fed through [eventQueue], so the transport thread never suspends and a slow
     * collector can lose old actions but never a `LinkUp` or `LinkDown`.
     */
    private val _events = MutableSharedFlow<AgentdEvent>(
        replay = 0,
        extraBufferCapacity = 256,
    )

    // Read-only on purpose, unlike the brief's MutableSharedFlow (R81): only eventQueue emits.
    val events: SharedFlow<AgentdEvent> = _events.asSharedFlow()

    private val _link = MutableStateFlow<AgentdLinkState?>(null)

    /** The live link's generation and trust, or null while no transport holds one. */
    val link: StateFlow<AgentdLinkState?> = _link.asStateFlow()

    private val eventQueue = AgentdEventQueue(
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        maxActions = 256,
        sink = { event -> _events.emit(event) },
        onDropped = { total -> Log.w(LOG_TAG, "agentd events: dropped $total old actions") },
    )

    /** Called from the transport thread, under its link binding's lock. */
    internal fun emitEvent(event: AgentdEvent) {
        when (event) {
            is AgentdEvent.LinkUp -> _link.value = AgentdLinkState(event.generation, event.secure)
            is AgentdEvent.LinkDown -> _link.update { if (it?.generation == event.generation) null else it }
            is AgentdEvent.Action -> Unit
        }
        eventQueue.offer(event)
    }

    private const val LOG_TAG = "AgentsRuntime"
}
