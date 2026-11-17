package com.anezium.rokidbus.plugin.agents

import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A phone away from home reaches its computer at another address of it: the pairing line, the
 * credentials and an authenticated link each teach the phone where, the dial tries them in turn, and
 * the screen says why when none answers. Only where to dial; the pin still says who answers.
 */
class TailnetHostsTest {
    private val lan = "192.168.68.104"
    private val tailnet = "100.78.52.6"

    // ----------------------------------------------------------------------- what counts as a host

    @Test
    fun valid_hosts_are_kept_in_order_without_repeats_and_capped_at_four() {
        assertEquals(
            listOf(lan, "100.78.52.6", "fd7a:115c:a1e0::1", "Desk.tail1234.ts.net"),
            EndpointHosts.clean(
                listOf(lan, " 100.78.52.6 ", "192.168.68.104", "fd7a:115c:a1e0::1", "Desk.tail1234.ts.net", "DESK.tail1234.ts.net", "10.0.0.9"),
            ),
        )
        assertEquals(4, EndpointHosts.clean(List(9) { "10.0.0.$it" }).size)
    }

    @Test
    fun anything_that_is_not_a_bare_address_or_name_is_dropped() {
        val garbage = listOf<Any?>(
            "", " ", "http://192.168.68.104", "192.168.68.104:8792", "192.168.68.104/x", "a b", "tab\there", "1.2.3.256",
            "1.2.3", "1.2.3.4.5", "[::1]", "fe80::1%wlan0", ":", "host?x=1", "user@host", "-bad.example", "a".repeat(254),
            "x".repeat(64) + ".example", 7, JSONObject.NULL, null, true,
        )
        assertEquals(emptyList<String>(), EndpointHosts.clean(garbage))
        assertEquals(listOf(lan), EndpointHosts.clean(garbage + lan))
        // The longest name that is still a name.
        val longest = List(4) { "a".repeat(61) }.joinToString(".")
        assertEquals(listOf(longest), EndpointHosts.clean(listOf(longest)))
    }

    @Test
    fun ipv6_literals_are_checked_by_structure() {
        val good = listOf(
            "fe80::1", "::1", "::", "2001:db8::1", "fd7a:115c:a1e0::1", "1:2:3:4:5:6:7:8", "1::8", "::ffff:192.168.1.1",
            "2001:DB8:0:0:0:0:0:1",
        )
        good.forEach { assertTrue(it, EndpointHosts.isValid(it)) }
        val bad = listOf(
            "::::", ":::", "1::2::3", "1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::8", "12345::1", "g::1", ":1::2",
            "1::2:", "1:::2", "1.2.3.4::", "::1.2.3.256", "::1.2.3", "fe80::1%eth0", "1:2:3:4:5:6:7:",
        )
        bad.forEach { assertFalse(it, EndpointHosts.isValid(it)) }
        assertEquals(emptyList<String>(), EndpointHosts.clean(bad))
        assertEquals(listOf("2001:db8::1"), EndpointHosts.clean(bad + "2001:db8::1"))
    }

    @Test
    fun the_line_and_the_frame_both_drop_a_bad_ipv6_entry() {
        val mixed = JSONArray(listOf("::::", "1::2::3", tailnet, "fe80::1"))
        assertEquals(listOf(tailnet, "fe80::1"), target(line(hosts = mixed)).hosts)
        assertEquals(AgentdAction.Endpoint(listOf(tailnet, "fe80::1"), 8792), parseFrame(endpointFrame(hosts = mixed)))
    }

    @Test
    fun a_saved_list_that_does_not_read_is_none() {
        assertEquals(emptyList<String>(), EndpointHosts.decode(null))
        assertEquals(emptyList<String>(), EndpointHosts.decode("not json"))
        assertEquals(listOf(tailnet), EndpointHosts.decode("""["$tailnet","a b"]"""))
        assertNull(EndpointHosts.encode(emptyList()))
    }

    // ----------------------------------------------------------------- the pairing line, v2

    private fun line(host: Any? = lan, hosts: Any? = null) = JSONObject()
        .put("v", 2).put("kind", "rokid-coder").put("host", host).put("port", 8792).put("fp", FP)
        .apply { if (hosts != null) put("hosts", hosts) }
        .toString()

    private fun target(raw: String) = (AgentdPairingParser.parse(raw) as AgentdPairingParseResult.Valid).target

    @Test
    fun the_line_carries_its_primary_and_the_full_list() {
        val parsed = target(line(hosts = JSONArray(listOf(lan, tailnet))))
        assertEquals(lan, parsed.host)
        assertEquals(listOf(lan, tailnet), parsed.hosts)
    }

    @Test
    fun a_list_of_garbage_is_ignored_and_the_line_still_pairs() {
        assertEquals(emptyList<String>(), target(line(hosts = JSONArray(listOf("a b", 5, "http://x")))).hosts)
        assertEquals(emptyList<String>(), target(line(hosts = "100.78.52.6")).hosts)
        assertEquals(emptyList<String>(), target(line(hosts = JSONObject().put("a", tailnet))).hosts)
    }

    @Test
    fun an_old_line_with_only_a_host_has_no_list() {
        val old = target(line())
        assertEquals(lan, old.host)
        assertEquals(emptyList<String>(), old.hosts)
    }

    // -------------------------------------------------------------- credentials and the record

    private val record = PairingRecord(
        machineId = "pc-1", machineName = "Desk", agentdFp = FP, token = "token-0123456789",
        steer = STEER, wsHost = lan, wsPort = 8792, attempt = "0123456789abcdef",
    )

    private fun credentials(wsHosts: Any? = null) = JSONObject()
        .put("machineId", "pc-1").put("machineName", "Desk").put("token", "token-0123456789").put("steer", STEER)
        .put("wsHost", lan).put("wsPort", 8792)
        .apply { if (wsHosts != null) put("wsHosts", wsHosts) }

    @Test
    fun credentials_with_ws_hosts_round_trip_and_the_slot_dials_the_others_after_the_primary() {
        val parsed = PairingRecord.fromCredentials(credentials(JSONArray(listOf(lan, tailnet, "a b"))), FP, "0123456789abcdef")!!
        assertEquals(listOf(lan, tailnet), parsed.wsHosts)
        assertEquals(parsed, PairingRecord.fromJson(parsed.toJson()))
        assertEquals(listOf(tailnet), parsed.outbound().altHosts)
        assertEquals(listOf(lan, tailnet), parsed.outbound().dialHosts)
        // Not in a string the record becomes.
        assertFalse(parsed.toString().contains(tailnet))
    }

    @Test
    fun credentials_from_an_older_computer_have_no_list() {
        val parsed = PairingRecord.fromCredentials(credentials(), FP, "0123456789abcdef")!!
        assertEquals(emptyList<String>(), parsed.wsHosts)
        assertEquals(emptyList<String>(), parsed.outbound().altHosts)
        // A record stored before the list existed reads back with none.
        assertEquals(record, PairingRecord.fromJson(record.toJson()))
        assertFalse(JSONObject(record.toJson()).has("wsHosts"))
        assertEquals(
            emptyList<String>(),
            PairingRecord.fromCredentials(credentials("not a list"), FP, "0123456789abcdef")!!.wsHosts,
        )
    }

    // ------------------------------------------------------------------------------- the store

    private val prefs = MemoryPrefs()
    private val store = AgentsConfigStore(prefs, wallClock = { 1_000L }, elapsedRealtime = { 0L })

    @Test
    fun a_pairing_saves_the_other_hosts_beside_the_primary() {
        assertTrue(store.commitPairing(record.copy(wsHosts = listOf(lan, tailnet))))
        val slot = store.load().agentd!!
        assertEquals(lan, slot.host)
        assertEquals(listOf(tailnet), slot.altHosts)
        // Another pairing without any clears what the last one had.
        assertTrue(store.commitPairing(record))
        assertEquals(emptyList<String>(), store.load().agentd!!.altHosts)
    }

    @Test
    fun a_save_from_before_alternate_hosts_loads_with_none() {
        prefs.map["agentd.host"] = lan
        prefs.map["agentd.port"] = 8792
        prefs.map["agentd.token"] = "tok"
        assertEquals(emptyList<String>(), store.load().agentd!!.altHosts)
        // A damaged value is none too, and the primary is never its own alternate.
        prefs.map["agentd.alt_hosts"] = "{"
        assertEquals(emptyList<String>(), store.load().agentd!!.altHosts)
        prefs.map["agentd.alt_hosts"] = """["$lan","$tailnet"]"""
        assertEquals(listOf(tailnet), store.load().agentd!!.altHosts)
    }

    @Test
    fun the_slot_saves_its_alternate_hosts_and_forgetting_it_forgets_them() {
        val config = AgentdConfig(lan, 8792, "tok", "Desk", FP, STEER, altHosts = listOf(tailnet))
        assertTrue(store.saveAgentd(config, enabled = true))
        assertEquals(config, store.load().agentd)
        assertTrue(store.saveAgentd(null, enabled = true))
        assertFalse(prefs.map.containsKey("agentd.alt_hosts"))
    }

    @Test
    fun the_config_string_still_leaks_nothing() {
        val shown = AgentdConfig(lan, 8792, "tok-secret", "Desk", FP, STEER, altHosts = listOf(tailnet)).toString()
        assertFalse(shown.contains("tok-secret"))
        assertFalse(shown.contains(STEER))
        assertFalse(shown.contains(FP))
    }

    // ------------------------------------------------------------ the endpoint frame, received

    private fun endpointFrame(hosts: Any? = JSONArray(listOf(lan, tailnet)), port: Any? = 8792, v: Int = 2) = JSONObject()
        .put("type", "endpoint").put("v", v)
        .apply {
            if (hosts != null) put("hosts", hosts)
            if (port != null) put("port", port)
        }
        .toString()

    private fun parseFrame(text: String) = AgentdProtocolCodec().parse(text)

    @Test
    fun a_valid_endpoint_frame_is_read() {
        assertEquals(AgentdAction.Endpoint(listOf(lan, tailnet), 8792), parseFrame(endpointFrame()))
    }

    @Test
    fun invalid_entries_are_dropped_and_the_list_is_capped_at_four() {
        val mixed = JSONArray(listOf(lan, "http://evil", "a b", 3, tailnet, lan, "10.0.0.1", "10.0.0.2", "10.0.0.3"))
        assertEquals(
            AgentdAction.Endpoint(listOf(lan, tailnet, "10.0.0.1", "10.0.0.2"), 8792),
            parseFrame(endpointFrame(hosts = mixed)),
        )
    }

    @Test
    fun a_frame_that_is_garbage_is_ignored_whole() {
        assertEquals(AgentdAction.Ignore, parseFrame(endpointFrame(hosts = JSONArray(listOf("a b", "http://x")))))
        assertEquals(AgentdAction.Ignore, parseFrame(endpointFrame(hosts = JSONArray())))
        assertEquals(AgentdAction.Ignore, parseFrame(endpointFrame(hosts = null)))
        assertEquals(AgentdAction.Ignore, parseFrame(endpointFrame(hosts = "100.78.52.6")))
        assertEquals(AgentdAction.Ignore, parseFrame(endpointFrame(v = 1)))
        // A port that is no port is no port, not a reason to lose the hosts.
        assertEquals(AgentdAction.Endpoint(listOf(lan, tailnet), null), parseFrame(endpointFrame(port = 99999)))
    }

    private fun slot() = store.commitPairing(record.copy(wsHosts = listOf(lan)))

    @Test
    fun learning_replaces_only_the_alternates_and_twice_is_the_same() {
        slot()
        assertTrue(store.learnAltHosts(FP, listOf(lan, tailnet), 8792))
        val learned = store.load().agentd!!
        assertEquals(lan, learned.host)
        assertEquals(listOf(tailnet), learned.altHosts)
        assertEquals(FP, learned.fp)
        assertEquals(STEER, learned.steer)
        // The same list again writes nothing.
        assertFalse(store.learnAltHosts(FP, listOf(lan, tailnet), 8792))
        assertFalse(store.learnAltHosts(FP, listOf(tailnet, lan), null))
        assertEquals(learned, store.load().agentd)
    }

    @Test
    fun a_frame_never_moves_the_primary_the_pin_or_the_port() {
        slot()
        assertTrue(store.learnAltHosts(FP, listOf("10.9.9.9", tailnet), null))
        val after = store.load().agentd!!
        assertEquals(lan, after.host)
        assertEquals(listOf("10.9.9.9", tailnet), after.altHosts)
        // Another port is dropped whole: the saved one is what is dialled.
        assertFalse(store.learnAltHosts(FP, listOf("10.1.1.1"), 9000))
        assertEquals(8792, store.load().agentd!!.port)
        assertEquals(after, store.load().agentd)
        // A link that is not this pairing's pin teaches nothing.
        assertFalse(store.learnAltHosts(FixturePhoneTlsIdentity.agentdA().fingerprint, listOf("10.1.1.1"), 8792))
        assertFalse(store.learnAltHosts("nope", listOf("10.1.1.1"), 8792))
        assertEquals(after, store.load().agentd)
    }

    @Test
    fun nothing_is_learned_without_a_pairing() {
        assertFalse(store.learnAltHosts(FP, listOf(tailnet), 8792))
    }

    // ------------------------------------------------------------------------ the dial order

    @Test
    fun the_address_that_worked_goes_first_and_only_while_it_is_still_listed() {
        val order = DialOrder()
        val hosts = listOf(lan, tailnet, "10.0.0.5")
        assertEquals(hosts, order.order(hosts))
        order.worked(tailnet)
        assertEquals(listOf(tailnet, lan, "10.0.0.5"), order.order(hosts))
        assertEquals(listOf(lan, "10.0.0.5"), order.order(listOf(lan, "10.0.0.5")))
    }

    // -------------------------------------------------------------------------- the copy

    @Test
    fun the_reason_names_every_address_and_says_what_to_do() {
        assertEquals(
            "Can't reach 192.168.68.104 or 100.78.52.6. Away from home? Turn on Tailscale on this phone and make sure your computer is on it too.",
            PairingCopy.cantReach(listOf(lan, tailnet)),
        )
        assertEquals(
            "Can't reach 192.168.68.104. If you're away from home, your computer needs Tailscale too.",
            PairingCopy.cantReach(listOf(lan)),
        )
        assertTrue(PairingCopy.cantReach(listOf(lan, tailnet, "10.0.0.1")).startsWith("Can't reach 192.168.68.104, 100.78.52.6 or 10.0.0.1. "))
        // The only address known is already the tailnet one: Tailscale is the thing to check, not the advice for a LAN.
        assertTrue(PairingCopy.cantReach(listOf(tailnet)).contains("Turn on Tailscale on this phone"))
        assertTrue(PairingCopy.isUnreachable(PairingCopy.cantReach(listOf(lan))))
        assertFalse(PairingCopy.isUnreachable("Connection lost"))
        assertFalse(PairingCopy.isUnreachable(null))
    }

    // -------------------------------------------------------------- the dial, with no sockets

    /** An AgentdClient on virtual time whose every connection is a fake the test answers or fails by hand. */
    private inner class Harness(deadlineMs: Long = DIAL_DEADLINE_MS, var alts: () -> List<String>? = { null }) {
        val test = TestScope()
        val wss = FakeWebSocketClient()
        val sessions = AgentSessionStore()
        val connected = CopyOnWriteArrayList<String?>()
        val endpoints = CopyOnWriteArrayList<Triple<String, List<String>, Int?>>()
        var beforeOpenClaim: () -> Unit = {}
        var beforeExpiryClaim: () -> Unit = {}
        val client = AgentdClient(
            OkHttpClient(), sessions, test, "test", FixturePhoneTlsIdentity(),
            pinnedClient = { wss },
            freshAltHosts = { alts() },
            connectDeadlineMs = deadlineMs,
            beforeOpenClaim = { beforeOpenClaim() },
            beforeExpiryClaim = { beforeExpiryClaim() },
            onSecureConnected = { _, _, _, address -> connected += address },
            onEndpoint = { fp, hosts, port -> endpoints += Triple(fp, hosts, port) },
        ) {}

        fun settle() = test.testScheduler.runCurrent()
        fun advance(ms: Long) {
            test.testScheduler.advanceTimeBy(ms)
            test.testScheduler.runCurrent()
        }

        fun dialled() = wss.connections.map { it.request.url.host }

        fun fail(index: Int, cause: Throwable = IOException("no route")) {
            settle()
            wss.connections[index].fail(cause)
            settle()
        }

        fun accept(index: Int) {
            settle()
            wss.connections[index].apply { open(); message(HELLO_ACK) }
            settle()
        }

        fun state() = sessions.connections.value.getValue(AgentProvider.CLAUDE)
    }

    private fun config(altHosts: List<String> = listOf(tailnet)) =
        AgentdConfig(lan, 8792, "tok", "Desk", FP, STEER, altHosts = altHosts)

    @Test
    fun the_primary_is_tried_first_then_each_alternate_inside_one_round() {
        val harness = Harness()
        harness.client.start(config(listOf(tailnet, "10.0.0.5")))
        harness.fail(0)
        harness.fail(1)
        // No backoff between the addresses of a round.
        assertEquals(listOf(lan, tailnet, "10.0.0.5"), harness.dialled())
        harness.accept(2)
        assertEquals(ConnectionState.CONNECTED, harness.state().state)
        // The address that was dialled, not the saved primary, is what the link reports.
        assertEquals(listOf<String?>("10.0.0.5"), harness.connected.toList())
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun the_address_that_worked_is_tried_first_next_time() {
        val harness = Harness()
        harness.client.start(config())
        harness.fail(0)
        harness.accept(1)
        assertEquals(listOf(lan, tailnet), harness.dialled())
        // The link drops; the redial starts where the last one worked.
        harness.wss.connections[1].close(1006)
        harness.settle()
        harness.advance(2_000L)
        assertEquals(listOf(lan, tailnet, tailnet), harness.dialled())
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun a_round_where_nothing_answers_is_one_failure_and_says_why() {
        val harness = Harness()
        harness.client.start(config())
        harness.fail(0)
        harness.fail(1)
        assertEquals(2, harness.wss.connections.size)
        val state = harness.state()
        assertEquals(ConnectionState.DISCONNECTED, state.state)
        assertEquals(PairingCopy.cantReach(listOf(lan, tailnet)), state.detail)
        // One backoff for the round, not one per address: the next round is a second or so away, not immediate.
        harness.advance(500L)
        assertEquals(2, harness.wss.connections.size)
        harness.advance(1_000L)
        // The next round starts over at the primary.
        assertEquals(listOf(lan, tailnet, lan), harness.dialled())
        // The reason stays on the screen while the next round runs.
        assertEquals(ConnectionState.CONNECTING, harness.state().state)
        assertEquals(PairingCopy.cantReach(listOf(lan, tailnet)), harness.state().detail)
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun a_single_address_says_the_lan_only_reason() {
        val harness = Harness()
        harness.client.start(config(emptyList()))
        harness.fail(0)
        assertEquals(PairingCopy.cantReach(listOf(lan)), harness.state().detail)
        assertTrue(harness.state().detail!!.contains("your computer needs Tailscale too"))
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun a_stranger_at_one_address_does_not_end_the_search_or_bury_the_other() {
        val harness = Harness()
        harness.client.start(config())
        // Away from home, the LAN address belongs to someone else's certificate.
        harness.fail(0, PinMismatchException())
        harness.accept(1)
        assertEquals(ConnectionState.CONNECTED, harness.state().state)
        assertFalse(harness.client.needsRepair.value)
        harness.client.stop(clearSessions = true)

        // A stranger at one and nothing at the other is not "re-pair" either: Tailscale may simply be off.
        val away = Harness()
        away.client.start(config())
        away.fail(0, PinMismatchException())
        away.fail(1)
        assertFalse(away.client.needsRepair.value)
        assertEquals(PairingCopy.cantReach(listOf(lan, tailnet)), away.state().detail)
        away.client.stop(clearSessions = true)

        // Every address answering with another certificate is final, as with one address.
        val changed = Harness()
        changed.client.start(config())
        changed.fail(0, PinMismatchException())
        changed.fail(1, PinMismatchException())
        assertTrue(changed.client.needsRepair.value)
        assertEquals(ConnectionState.AUTH_FAILED, changed.state().state)
        assertEquals(PairingCopy.CERT_CHANGED, changed.state().detail)
        changed.client.stop(clearSessions = true)
    }

    @Test
    fun an_alternate_learned_between_rounds_is_dialled_from_the_next_round() {
        val learned = CopyOnWriteArrayList<String>()
        val harness = Harness(alts = { learned.toList() })
        harness.client.start(config(emptyList()))
        harness.fail(0)
        assertEquals(listOf(lan), harness.dialled())
        learned += tailnet
        harness.advance(1_300L)
        harness.fail(1)
        assertEquals(listOf(lan, lan, tailnet), harness.dialled())
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun an_address_that_cannot_be_dialled_costs_only_itself() {
        // Saved before the validator, or by a bug: the request for it throws.
        val harness = Harness(alts = { listOf("::::", tailnet) })
        harness.client.start(config())
        harness.fail(0)
        assertEquals(listOf(lan, tailnet), harness.dialled())
        harness.accept(1)
        assertEquals(ConnectionState.CONNECTED, harness.state().state)
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun a_throwing_attempt_is_skipped_and_the_round_goes_on() {
        val tried = mutableListOf<String>()
        val outcome = kotlinx.coroutines.runBlocking {
            dialRound(listOf("bad", tailnet), listOf("bad", tailnet)) { host ->
                tried += host
                if (host == "bad") throw IllegalArgumentException("not a url") else ConnectionOutcome.Retry
            }
        }
        assertEquals(listOf("bad", tailnet), tried)
        assertEquals(ConnectionOutcome.Retry, outcome)
    }

    @Test
    fun an_address_that_never_finishes_connecting_is_abandoned_for_the_next_one() {
        val harness = Harness()
        harness.client.start(config())
        harness.settle()
        // Opened nothing, failed nothing: TCP taken, TLS never answered.
        harness.advance(DIAL_DEADLINE_MS - 1)
        assertEquals(listOf(lan), harness.dialled())
        harness.advance(1)
        harness.settle()
        assertEquals(listOf(lan, tailnet), harness.dialled())
        harness.accept(1)
        assertEquals(ConnectionState.CONNECTED, harness.state().state)
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun an_attempt_the_deadline_took_first_never_sends_the_hello() {
        val harness = Harness()
        harness.client.start(config())
        harness.settle()
        // The socket opens, passes its liveness check, and the deadline fires before onOpen claims the attempt.
        harness.beforeOpenClaim = {
            harness.beforeOpenClaim = {}
            harness.advance(DIAL_DEADLINE_MS)
        }
        harness.wss.connections[0].open()
        harness.settle()
        assertTrue("no token or secret on an expired attempt", harness.wss.connections[0].sent.isEmpty())
        // The expiry stood: the next address is the one dialled.
        assertEquals(listOf(lan, tailnet), harness.dialled())
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun an_attempt_that_opened_first_is_never_discarded_by_the_deadline() {
        val harness = Harness()
        harness.client.start(config())
        harness.settle()
        // The deadline has read that nothing opened and is about to discard; the open lands in that gap.
        harness.beforeExpiryClaim = {
            harness.beforeExpiryClaim = {}
            harness.wss.connections[0].open()
        }
        harness.advance(DIAL_DEADLINE_MS)
        assertEquals(1, harness.wss.connections[0].sent.size)
        assertEquals(listOf(lan), harness.dialled())
        harness.wss.connections[0].message(HELLO_ACK)
        harness.settle()
        assertEquals(ConnectionState.CONNECTED, harness.state().state)
        harness.advance(DIAL_DEADLINE_MS)
        assertEquals(listOf(lan), harness.dialled())
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun a_whole_round_of_silent_hosts_ends_after_one_deadline_each() {
        val harness = Harness()
        harness.client.start(config())
        harness.settle()
        harness.advance(DIAL_DEADLINE_MS)
        harness.advance(DIAL_DEADLINE_MS)
        assertEquals(listOf(lan, tailnet), harness.dialled())
        assertEquals(PairingCopy.cantReach(listOf(lan, tailnet)), harness.state().detail)
        harness.client.stop(clearSessions = true)
    }

    @Test
    fun a_host_that_takes_tcp_and_never_speaks_tls_does_not_hold_the_dial() {
        val accepts = java.util.concurrent.atomic.AtomicInteger()
        val held = CopyOnWriteArrayList<java.net.Socket>()
        java.net.ServerSocket(0).use { silent ->
            val acceptor = kotlin.concurrent.thread(isDaemon = true) {
                while (true) {
                    val socket = runCatching { silent.accept() }.getOrNull() ?: break
                    accepts.incrementAndGet()
                    held += socket
                }
            }
            val scope = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO)
            try {
                // As in production: no read timeout, so only the deadline can end a handshake nobody answers.
                val base = OkHttpClient.Builder().readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS).build()
                val client = AgentdClient(
                    base, AgentSessionStore(), scope, "test", FixturePhoneTlsIdentity(), connectDeadlineMs = 400,
                ) {}
                client.start(AgentdConfig("127.0.0.1", silent.localPort, "tok", "Desk", FP, STEER, altHosts = listOf("localhost")))
                val deadline = System.currentTimeMillis() + 5_000
                // The second accept is the second address: without the deadline the first would hold the round forever.
                while (accepts.get() < 2 && System.currentTimeMillis() < deadline) Thread.sleep(20)
                assertTrue("accepted ${accepts.get()}", accepts.get() >= 2)
                client.stop(clearSessions = true)
            } finally {
                scope.cancel()
                held.forEach { runCatching { it.close() } }
                silent.close()
                acceptor.join(2_000)
            }
        }
    }

    @Test
    fun an_endpoint_frame_is_acted_on_only_past_the_pinned_hello() {
        val harness = Harness()
        harness.client.start(config())
        harness.settle()
        val socket = harness.wss.connections[0]
        // The TLS pin held, but no hello was acknowledged: the peer has proved a certificate and nothing more.
        socket.open()
        socket.message(endpointFrame())
        harness.settle()
        assertTrue(harness.endpoints.isEmpty())

        socket.message(HELLO_ACK)
        socket.message(endpointFrame())
        harness.settle()
        assertEquals(listOf(Triple(FP, listOf(lan, tailnet), 8792 as Int?)), harness.endpoints.toList())
        // Garbage is never passed on.
        socket.message(endpointFrame(hosts = JSONArray(listOf("a b"))))
        harness.settle()
        assertEquals(1, harness.endpoints.size)
        harness.client.stop(clearSessions = true)
    }

    // ----------------------------------------------------------------------------- the fakes

    private class FakeConnection(val listener: WebSocketListener, val request: Request) {
        val sent = CopyOnWriteArrayList<String>()

        val socket = object : WebSocket {
            override fun request(): Request = request
            override fun queueSize(): Long = 0L
            override fun send(text: String): Boolean = sent.add(text)
            override fun send(bytes: ByteString): Boolean = false
            override fun close(code: Int, reason: String?): Boolean = true
            override fun cancel() = Unit
        }

        fun open() = listener.onOpen(
            socket,
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("Switching Protocols").build(),
        )

        fun message(text: String) = listener.onMessage(socket, text)

        fun fail(cause: Throwable) = listener.onFailure(socket, cause, null)

        fun close(code: Int) {
            listener.onClosing(socket, code, "")
            listener.onClosed(socket, code, "")
        }
    }

    private class FakeWebSocketClient : OkHttpClient() {
        val connections = CopyOnWriteArrayList<FakeConnection>()

        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            FakeConnection(listener, request).also(connections::add).socket
    }

    private companion object {
        const val FP = FixturePhoneTlsIdentity.FINGERPRINT
        const val STEER = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123"
        const val HELLO_ACK = """{"type":"hello_ack","v":1,"steering":true,"server":{"machineName":"Desk"}}"""
    }
}
