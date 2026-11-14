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

    /** Only an item that allows free text takes any; blank text clears it. */
    fun setFreeText(itemIndex: Int, text: String) {
        val item = payload.items.getOrNull(itemIndex) ?: return
        if (!item.allowFreeText) return
        val clean = text.trim().take(MAX_ANSWER_CHARS).takeIf { it.isNotEmpty() }
        if (clean != null && item.multiSelect && picked[itemIndex].size >= MAX_ANSWER_ENTRIES) return
        typed[itemIndex] = clean
        if (clean != null && !item.multiSelect) picked[itemIndex].clear()
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

    private companion object {
        val FORBIDDEN_KEYS = setOf("__proto__", "constructor", "prototype")
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
