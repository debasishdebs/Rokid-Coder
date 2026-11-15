package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import java.security.MessageDigest
import java.util.UUID

/**
 * The phone's mirror of agentd's alert queue: decides when the glasses band
 * shows, refreshes, wakes and sounds, and what goes back to agentd. agentd owns
 * the order, the dwell and the preemption; this only follows the `reason` each
 * frame carries and never holds the alerts waiting behind the current one.
 *
 * A display episode is one band instance, from its show until that band
 * closes. Display evidence belongs to the episode: the first evidence sends
 * `alert_shown`, and a `retry` or `resume` of the same band while it has
 * evidence sends it again (R84), since agentd takes an ack only while the
 * alert is out on the wire.
 * Only the wearer's own doing is evidence (R33): the hub's shown report, an
 * action, an input, a close by the user. A timeout, replacement, owner hide or
 * disconnect is not, since the glasses can time out a band that never attached (R47).
 *
 * Pure and not thread-safe: the service calls it from one coroutine, routes
 * every [Effect.Send] through `AgentdWire.write`, which classifies the frame by
 * its type, and renders the rest. The session and harness of an alert come
 * from its `sessionKey` only (R79).
 */
class AlertCoordinator(
    private val clock: () -> Long,
    private val newMsgId: () -> String = { UUID.randomUUID().toString() },
) {
    sealed interface Effect {
        /** A fresh band for [alert], replacing any band up now. */
        data class Show(val alert: AgentdAction.Alert, val wake: Boolean, val sound: Boolean) : Effect

        /** The same band, refreshed in place (`+N waiting`, text); never sounds. */
        data class Update(val alert: AgentdAction.Alert) : Effect
        data object Hide : Effect

        /**
         * A line for agentd, built by the codec. An [attempt] says it answers an alert
         * from here; it is recorded only once the wire reports the line written.
         */
        data class Send(val line: String, val attempt: Attempt? = null) : Effect

        /** The wearer answered [alertId] with [label] (`Allowed`, `Denied`, `Answered`). */
        data class Attempt(val alertId: String, val label: String)

        /** The wearer dismissed or closed [alertId]'s band. */
        data class Dismissed(val alertId: String) : Effect

        /** agentd refused what this phone sent for [alertId]. */
        data class Rejected(val alertId: String, val error: String) : Effect

        /** agentd closed [alertId] for [reason] (`acted`, `expired`, `withdrawn`). */
        data class Closed(val alertId: String, val reason: String) : Effect
        data class Brief(val title: String, val body: String) : Effect

        /** Drop the decision or question card and any voice draft bound to [alertId]. */
        data class Invalidate(val alertId: String) : Effect

        /** The wearer asked for more on [alert]: open its decision card, bound to it. */
        data class OpenDecision(val alert: AgentdAction.Alert) : Effect

        /** The wearer will answer [alert]: open its question card, bound to it. */
        data class OpenQuestion(val alert: AgentdAction.Alert) : Effect
    }

    private class Episode(val alert: AgentdAction.Alert) {
        var evidence = false
    }

    /** What the phone remembers of an id across its bands, until agentd closes it or the link comes back. */
    private class Seen {
        var evidence = false
        var wokeAt: Long? = null
        val msgIds = HashMap<String, String>()
    }

    private var episode: Episode? = null
    private val seen = bounded<Seen>()
    private val cards = bounded<AgentdAction.Alert>()

    /** The alert whose band is up, or null. */
    val current: AgentdAction.Alert? get() = episode?.alert

    fun onAlert(alert: AgentdAction.Alert): List<Effect> {
        val up = episode?.takeIf { it.alert.id == alert.id }
        return when (alert.reason) {
            AlertReason.NEW -> show(alert, wake = true, sound = true)
            // A reminder wakes the glasses but never speaks: the wearer already heard this alert.
            AlertReason.REMINDER -> show(alert, wake = true, sound = false)
            AlertReason.RETRY, AlertReason.RESUME -> if (up != null) {
                refresh(up, alert) + if (up.evidence) listOf(shown(alert.id)) else emptyList()
            } else {
                show(alert, wake = unconfirmed(alert.id), sound = false)
            }
            AlertReason.UPDATE -> if (up != null) refresh(up, alert) else emptyList()
        }
    }

    /** agentd closed the alert for a reason the glasses did not cause. */
    fun onAlertClosed(id: String, reason: String): List<Effect> {
        val effects = mutableListOf<Effect>(Effect.Closed(id, reason))
        if (episode?.alert?.id == id) {
            episode = null
            effects += Effect.Hide
        }
        if (cards.remove(id) != null) effects += Effect.Invalidate(id)
        seen.remove(id)
        return effects
    }

    /**
     * After hello_ack, before any later frame: whatever the phone held may be
     * stale. agentd requeues its former occupant and sends by priority, so
     * nothing here expects a replay or an order (R28).
     */
    fun onLinkUp(): List<Effect> {
        episode = null
        seen.clear()
        return listOf(Effect.Hide) + invalidateWhere { true }
    }

    /** A card answered over a link that is gone would answer nothing; the band stays until the link is back. */
    fun onLinkDown(): List<Effect> = invalidateWhere { true }

    /** The session left the board, or its follow-up closed: its bound cards answer nothing any more. */
    fun invalidateSession(sessionKey: String): List<Effect> = invalidateWhere { it.sessionKey == sessionKey }

    /** The hub's `/notice/shown` or `/notice/input` for this id's band. */
    fun onShownEvidence(id: String): List<Effect> = evidence(id)

    /**
     * A notice action pressed on the band showing [id]. The press is display
     * evidence, whatever the action. A band that is not up any more has nothing
     * left to answer.
     */
    fun onAction(id: String, action: String, secure: Boolean): List<Effect> {
        val alert = episode?.alert?.takeIf { it.id == id } ?: return listOf(noLongerWaiting())
        val effects = evidence(id).toMutableList()
        when (action) {
            ALLOW, DENY -> effects += answer(id, action, secure)
            // A card for the wrong kind would offer what agentd cannot take.
            MORE -> if (alert.kind == AlertKind.APPROVAL) {
                cards[id] = alert
                effects += Effect.OpenDecision(alert)
            }
            ANSWER -> if (alert.kind == AlertKind.QUESTION) {
                cards[id] = alert
                effects += Effect.OpenQuestion(alert)
            }
            LATER -> {
                episode = null
                effects += Effect.Hide
                effects += Effect.Send(AgentdProtocolCodec.alertDismissed(id))
                effects += Effect.Dismissed(id)
            }
        }
        return effects
    }

    /**
     * A confirm from the card bound to [id]. It needs that binding to be live:
     * a card invalidated since it opened answers nothing, even while the band
     * still shows the same id. A card is no display evidence for the band.
     */
    fun onCardConfirm(id: String, action: String, secure: Boolean): List<Effect> {
        if (id !in cards) return listOf(noLongerWaiting())
        return when (action) {
            ALLOW, DENY -> listOf(answer(id, action, secure))
            LATER -> {
                cards.remove(id)
                listOf(Effect.Send(AgentdProtocolCodec.alertDismissed(id)), Effect.Dismissed(id))
            }
            else -> emptyList()
        }
    }

    /**
     * The wearer's answers from the question card bound to [id]. It goes through
     * the same live-binding gate as [onCardConfirm]: a card invalidated since it
     * opened (alert closed, link down, session gone, follow-up closed) sends
     * nothing. The frame is built here from the bound alert, so a card can only
     * answer the question it was opened for.
     */
    fun onQuestionConfirm(id: String, answers: Map<String, Any>, secure: Boolean): List<Effect> {
        val alert = cards[id]
        val question = alert?.question
        if (alert == null || alert.kind != AlertKind.QUESTION || question == null) {
            return listOf(noLongerWaiting())
        }
        if (!secure) return listOf(notConnected())
        val line = try {
            AgentdProtocolCodec.questionAnswer(
                sessionKey = alert.sessionKey,
                alertId = id,
                requestRef = question.requestRef,
                answers = answers,
                msgId = msgIdFor(id, QUESTION_ANSWER + ":" + contentKey(answers)),
            )
        } catch (_: IllegalArgumentException) {
            return listOf(Effect.Brief(NOT_SENT, NOT_SENT_BODY))
        }
        return listOf(Effect.Send(line, Effect.Attempt(id, AlertHistory.ANSWERED)))
    }

    /**
     * agentd refused an answer this coordinator sent (`alert_action` or
     * `question_answer`): the wearer must not believe they answered. The brief is
     * the only word: an approval or a question has no menu line to keep it on.
     */
    fun onAck(ack: AgentdAction.Ack): List<Effect> {
        if (ack.msgId.isEmpty() || (ack.result != "rejected" && ack.result != "duplicate")) return emptyList()
        val id = seen.entries.firstOrNull { ack.msgId in it.value.msgIds.values }?.key ?: return emptyList()
        // The answer already reached agentd (a re-tap after a lost ack): say so; nothing was refused.
        if (ack.result == "duplicate") return listOf(Effect.Brief(ALREADY_ANSWERED, ""))
        val why = ack.error?.singleLine(REJECTION_CHARS)?.takeIf(String::isNotBlank)
        return listOf(
            Effect.Rejected(id, why ?: REFUSED),
            Effect.Brief(NOT_SENT, if (why != null) "$NOT_SENT_BODY · $why" else NOT_SENT_BODY),
        )
    }

    /** The band for [id] closed. Only the wearer's close is evidence; any close ends the episode. */
    fun onBandClosed(id: String, reason: NexusNoticeCloseReason): List<Effect> {
        if (episode?.alert?.id != id) return emptyList()
        val effects = if (reason == NexusNoticeCloseReason.USER) {
            // agentd parks an approval or question and brings it back as a reminder (R22).
            evidence(id) + Effect.Send(AgentdProtocolCodec.alertDismissed(id)) + Effect.Dismissed(id)
        } else {
            emptyList()
        }
        episode = null
        return effects
    }

    private fun show(alert: AgentdAction.Alert, wake: Boolean, sound: Boolean): List<Effect> {
        episode = Episode(alert)
        if (wake) seenOf(alert.id).wokeAt = clock()
        return listOf(Effect.Show(alert, wake = wake, sound = sound))
    }

    private fun refresh(up: Episode, alert: AgentdAction.Alert): List<Effect> {
        episode = Episode(alert).also { it.evidence = up.evidence }
        return listOf(Effect.Update(alert))
    }

    /** Never shown, and no wake asked for in the last minute: worth a fresh wake after a failed or throttled one. */
    private fun unconfirmed(id: String): Boolean {
        val seen = seen[id] ?: return true
        val wokeAt = seen.wokeAt
        return !seen.evidence && (wokeAt == null || clock() - wokeAt >= WAKE_INTERVAL_MS)
    }

    private fun evidence(id: String): List<Effect> {
        val live = episode?.takeIf { it.alert.id == id } ?: return emptyList()
        seenOf(id).evidence = true
        if (live.evidence) return emptyList()
        live.evidence = true
        return listOf(shown(id))
    }

    private fun shown(id: String): Effect = Effect.Send(AgentdProtocolCodec.alertShown(id))

    private fun answer(id: String, action: String, secure: Boolean): Effect = when {
        !secure -> notConnected()
        // The last lock: no glasses path allows a command agentd had to cut (R128).
        action == ALLOW && alertOf(id)?.truncated == true -> Effect.Brief(NOT_SENT, AlertNotices.COMMAND_CUT)
        else -> Effect.Send(
            AgentdProtocolCodec.alertAction(id, action, msgIdFor(id, action)),
            Effect.Attempt(id, if (action == ALLOW) AlertHistory.ALLOWED else AlertHistory.DENIED),
        )
    }

    private fun alertOf(id: String): AgentdAction.Alert? = episode?.alert?.takeIf { it.id == id } ?: cards[id]

    private fun noLongerWaiting(): Effect = Effect.Brief(NO_LONGER_WAITING, NO_LONGER_WAITING_BODY)

    /** A steering press with no secure link up: the wire would refuse it, so it is not tried. */
    private fun notConnected(): Effect = Effect.Brief(NOT_SENT, NOT_CONNECTED)

    /** One msgId per (alert, action), reused when the wearer presses it again, so agentd applies it once. */
    private fun msgIdFor(id: String, action: String): String =
        seenOf(id).msgIds.getOrPut(action, newMsgId)

    /** Equal answers give the same key, in any order; a corrected answer gives another (R102). */
    private fun contentKey(answers: Map<String, Any>): String {
        val text = answers.entries.sortedBy { it.key }.joinToString("\u0001") { (question, answer) ->
            question + "\u0002" + when (answer) {
                is List<*> -> "L" + answer.joinToString("\u0003")
                else -> "S$answer"
            }
        }
        return MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            .joinToString("") { "%02x".format(it) }.take(16)
    }

    private fun seenOf(id: String): Seen = seen.getOrPut(id, ::Seen)

    private fun invalidateWhere(predicate: (AgentdAction.Alert) -> Boolean): List<Effect> {
        val gone = cards.values.filter(predicate).map { it.id }
        gone.forEach(cards::remove)
        return gone.map(Effect::Invalidate)
    }

    companion object {
        const val WAKE_INTERVAL_MS = 60_000L
        const val NO_LONGER_WAITING = "No longer waiting"
        const val NO_LONGER_WAITING_BODY = "Answer on laptop if still needed"
        const val NOT_SENT = "Not sent"
        const val ALREADY_ANSWERED = "Already answered"
        const val NOT_SENT_BODY = "Answer on laptop"
        const val NOT_CONNECTED = "Computer not connected"
        private const val QUESTION_ANSWER = "question_answer"
        private const val REJECTION_CHARS = 120
        private const val REFUSED = "refused"

        const val ALLOW = "allow"
        const val DENY = "deny"
        const val MORE = "more"
        const val ANSWER = "answer"
        const val LATER = "later"

        /**
         * agentd closes an id without telling the phone when the glasses
         * dismissed it, so what the phone remembers per id is capped. The maps
         * are in access order, so the ids in use are the last to go.
         */
        private const val MAX_TRACKED_IDS = 64

        /** The band's footer, or null when nothing waits behind the alert. */
        fun footer(alert: AgentdAction.Alert): String? =
            alert.waiting.takeIf { it > 0 }?.let { "+$it waiting" }

        private fun <V> bounded(): LinkedHashMap<String, V> = object : LinkedHashMap<String, V>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, V>?): Boolean =
                size > MAX_TRACKED_IDS
        }
    }
}
