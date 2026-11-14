package com.anezium.rokidbus.plugin.agents

/**
 * Which card is on the glasses screen (R104). There is exactly one, and a
 * confirm may only reach the card that is on screen: opening a card replaces the
 * one before it, and [accepts] says yes only for the current card, only once its
 * ENTER guard has run out. The guard restarts whenever a card opens, or is
 * revealed because the card above it closed, so the tail of a double tap aimed
 * at one card never lands on another.
 *
 * The one exception is a child card, such as the voice card of a question's
 * answer box: it sits over its parent, and gives the screen back to it when it
 * closes. The parent is hidden meanwhile and accepts nothing.
 *
 * Pure bookkeeping: [GlassesScreen] keeps each card's own data and clears it when
 * it opens another kind. The control menu is a card too, so its ENTER guard is
 * this one.
 */
class ActiveCard(private val guardMs: Long = 600L) {
    enum class Kind { NONE, VOICE, QUESTION, ALERT_DECISION, REQUEST_DECISION, REPLY, MENU }

    var kind: Kind = Kind.NONE
        private set

    /** The card hidden under a child, or NONE. */
    var parent: Kind = Kind.NONE
        private set

    private var guardUntil = 0L

    /** [kind] takes the screen; whatever was on it, and under it, is gone. */
    fun open(kind: Kind, now: Long) {
        this.kind = kind
        parent = Kind.NONE
        guardUntil = now + guardMs
    }

    /** [kind] takes the screen over the current card, which is kept to be given back. */
    fun openChild(kind: Kind, now: Long) {
        val under = this.kind
        open(kind, now)
        parent = under
    }

    /** [kind] is closed, wherever it is: on screen, the screen goes to its parent, and a hidden parent is dropped. */
    fun close(kind: Kind, now: Long) {
        when {
            this.kind == kind -> {
                this.kind = parent
                parent = Kind.NONE
                guardUntil = now + guardMs
            }
            parent == kind -> parent = Kind.NONE
        }
    }

    /** The card changed what it shows: a tap aimed at the old picture must not land on the new one. */
    fun rearm(now: Long) {
        guardUntil = now + guardMs
    }

    fun accepts(kind: Kind, now: Long): Boolean = kind != Kind.NONE && this.kind == kind && now >= guardUntil
}
