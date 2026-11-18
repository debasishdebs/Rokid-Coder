package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.withTimeoutOrNull
import java.net.InetSocketAddress
import java.net.URI
import java.nio.channels.SocketChannel

/** How long one address gets to accept the connection before the next is tried. */
internal const val DIAL_CONNECT_TIMEOUT_MS = 4_000L

/**
 * How long one address gets for the whole of establishing the link (TCP, TLS and the upgrade). The connect
 * timeout alone leaves a host that accepts TCP and never answers TLS holding the dial forever.
 */
internal const val DIAL_DEADLINE_MS = 6_000L

/** How long the addresses of one computer get to answer a bare TCP connect before the dial goes in saved order. */
internal const val REACH_PROBE_MS = 1_500L

/**
 * [order] with the address that answers a bare TCP connect first moved to the front. Every address is
 * probed at once, so a stale LAN address (a laptop that moved to another network) no longer holds the dial
 * for its whole deadline before the tailnet address gets its turn. Only the order changes: the dial that
 * follows is the same pinned wss dial, and an answer here proves nothing about who answered. With one
 * address, or none answering within [timeoutMs], [order] comes back as it was.
 */
internal suspend fun reachableFirst(
    order: List<String>,
    timeoutMs: Long = REACH_PROBE_MS,
    probe: suspend (host: String) -> Boolean,
): List<String> {
    if (order.size < 2) return order
    val first = withTimeoutOrNull(timeoutMs) {
        coroutineScope {
            val answers = Channel<String?>(order.size)
            order.forEach { host ->
                launch { answers.trySend(if (runCatching { probe(host) }.getOrDefault(false)) host else null) }
            }
            var winner: String? = null
            for (answered in order.indices) {
                winner = answers.receive()
                if (winner != null) break
            }
            coroutineContext.cancelChildren()
            winner
        }
    } ?: return order
    return listOf(first) + order.filterNot { it == first }
}

/** A bare TCP connect to [host]:[port] within [REACH_PROBE_MS]; nothing is written, so agentd sees only a closed connection. */
internal suspend fun tcpReachable(host: String, port: Int): Boolean = runInterruptible(Dispatchers.IO) {
    SocketChannel.open().use { channel ->
        channel.socket().connect(InetSocketAddress(host, port), REACH_PROBE_MS.toInt())
        true
    }
}

/** The host and port a saved address and the pairing's port dial, as [webSocketUrl] reads them. */
internal fun dialTarget(hostInput: String, port: Int): Pair<String, Int>? = runCatching {
    val uri = URI(webSocketUrl(hostInput, port, secure = true))
    uri.host.removeSurrounding("[", "]") to (uri.port.takeIf { it >= 0 } ?: port)
}.getOrNull()

/** Which of a computer's addresses answered last, so the next dial starts there. */
internal class DialOrder {
    @Volatile private var lastWorked: String? = null

    fun worked(host: String) {
        lastWorked = host
    }

    /** [hosts] with the address that last worked first, when it is still one of them. */
    fun order(hosts: List<String>): List<String> {
        val first = hosts.firstOrNull { it.equals(lastWorked, ignoreCase = true) } ?: return hosts
        return listOf(first) + hosts.filterNot { it.equals(first, ignoreCase = true) }
    }
}

/**
 * One round: [order]'s addresses in turn, until one is not [ConnectionOutcome.NotThere]. Whatever
 * that one says is the round's outcome, so a link that came up and later ended is not retried
 * against the others. A round where nothing was there is one failure for the backoff; [shown]
 * (the saved order, whatever was tried first) is what the reason names.
 *
 * A certificate that is not the pinned one is final only when no other address was merely out of
 * reach: a stranger at the home LAN address while away must not bury a computer still reachable
 * over Tailscale under "re-pair".
 */
internal suspend fun dialRound(
    order: List<String>,
    shown: List<String>,
    attempt: suspend (host: String) -> ConnectionOutcome,
): ConnectionOutcome {
    val misses = mutableListOf<ConnectionOutcome.NotThere>()
    for (host in order) {
        // One entry that cannot even be turned into a request must cost only itself.
        val result = try {
            attempt(host)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            ConnectionOutcome.NotThere(ConnectionOutcome.Retry, unreachable = true)
        }
        when (val outcome = result) {
            is ConnectionOutcome.NotThere -> misses += outcome
            else -> return outcome
        }
    }
    val refused = misses.map { it.fallback }.filterIsInstance<ConnectionOutcome.AuthFailed>()
    return when {
        misses.isEmpty() -> ConnectionOutcome.Retry
        refused.size == misses.size -> refused.first()
        misses.any { it.unreachable } -> ConnectionOutcome.RetryWithDetail(PairingCopy.cantReach(shown))
        else -> misses.map { it.fallback }.first { it !is ConnectionOutcome.AuthFailed }
    }
}
