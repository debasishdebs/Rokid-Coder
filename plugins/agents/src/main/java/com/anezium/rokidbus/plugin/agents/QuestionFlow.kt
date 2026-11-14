package com.anezium.rokidbus.plugin.agents

/**
 * The wearer's answers to one question alert, item by item. Pure: the service
 * draws a page per item from the read accessors and sends [answers] only when
 * every item has one. The key of an answer is the item's own text, which is how
 * agentd matches it; the value is a String, or a List<String> for a multi-select.
 */
class QuestionFlow(val alertId: String, val sessionKey: String, val payload: QuestionPayload) {
    private val picked = payload.items.map { sortedSetOf<Int>() }
    private val typed = arrayOfNulls<String>(payload.items.size)

    val itemCount: Int get() = payload.items.size

    /** A single-select pick replaces the one before; a multi-select pick toggles. */
    fun toggle(itemIndex: Int, optionIndex: Int) {
        val item = payload.items.getOrNull(itemIndex) ?: return
        if (optionIndex !in item.options.indices) return
        val set = picked[itemIndex]
        if (item.multiSelect) {
            // agentd takes at most MAX_ANSWER_ENTRIES parts; a pick past that would only be refused at the end.
            if (!set.remove(optionIndex) && set.size + (if (typed[itemIndex] != null) 1 else 0) < MAX_ANSWER_ENTRIES) {
                set.add(optionIndex)
            }
        } else {
            set.clear()
            set.add(optionIndex)
            // One answer for one question: a pick takes the place of what was said.
            typed[itemIndex] = null
        }
    }

    /**
     * Only an item that allows free text takes any; blank text clears it. A text
     * longer than agentd takes as one answer ([MAX_ANSWER_CHARS]) is refused, never
     * cut: false when the text was not taken. The card shows a long one condensed.
     */
    fun setFreeText(itemIndex: Int, text: String): Boolean {
        val item = payload.items.getOrNull(itemIndex) ?: return false
        if (!item.allowFreeText) return false
        val clean = text.trim().takeIf { it.isNotEmpty() }
        if (clean != null && clean.length > MAX_ANSWER_CHARS) return false
        if (clean != null && item.multiSelect && picked[itemIndex].size >= MAX_ANSWER_ENTRIES) return false
        typed[itemIndex] = clean
        if (clean != null && !item.multiSelect) picked[itemIndex].clear()
        return true
    }

    fun isPicked(itemIndex: Int, optionIndex: Int): Boolean = optionIndex in picked.getOrNull(itemIndex).orEmpty()

    fun freeText(itemIndex: Int): String? = typed.getOrNull(itemIndex)

    fun isAnswered(itemIndex: Int): Boolean = answerOf(itemIndex) != null

    /** Null until every item has an answer (and while two items share one text, which one key cannot hold). */
    fun answers(): Map<String, Any>? {
        val texts = payload.items.map { it.text }
        if (texts.toSet().size != texts.size) return null
        // agentd refuses these as keys: the answers are indexed by question text.
        if (texts.any { it in FORBIDDEN_KEYS }) return null
        val result = LinkedHashMap<String, Any>()
        for (index in payload.items.indices) {
            result[payload.items[index].text] = answerOf(index) ?: return null
        }
        return result
    }

    companion object {
        /** What the glasses say when [setFreeText] refuses a text for its length. */
        const val TOO_LONG = "Answer too long — answer on laptop"

        private val FORBIDDEN_KEYS = setOf("__proto__", "constructor", "prototype")
    }

    private fun answerOf(itemIndex: Int): Any? {
        val item = payload.items.getOrNull(itemIndex) ?: return null
        val labels = picked[itemIndex].map { item.options[it].label }
        val said = typed[itemIndex]
        return if (item.multiSelect) {
            (labels + listOfNotNull(said)).takeIf { it.isNotEmpty() }
        } else {
            said ?: labels.firstOrNull()
        }
    }
}
