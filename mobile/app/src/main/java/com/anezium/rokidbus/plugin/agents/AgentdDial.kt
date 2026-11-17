package com.anezium.rokidbus.plugin.agents

/** How long one address gets to accept the connection before the next is tried. */
internal const val DIAL_CONNECT_TIMEOUT_MS = 4_000L

/**
 * How long one address gets for the whole of establishing the link (TCP, TLS and the upgrade). The connect
 * timeout alone leaves a host that accepts TCP and never answers TLS holding the dial forever.
 */
internal const val DIAL_DEADLINE_MS = 6_000L

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
