package com.anezium.rokidbus.plugin.agents

/**
 * Which card of a question alert is on screen: one card per question, then, for
 * more than one question, a review card. Pure; the answers live in [flow], which
 * the deck only reads. [index] counts questions from 0, and is the question count
 * itself while the review card is up.
 */
class QuestionDeck(val flow: QuestionFlow) {
    var index = 0
        private set

    val questionCount: Int get() = flow.itemCount

    /** One question needs no review: its card carries the send row itself. */
    val hasReview: Boolean get() = questionCount > 1

    val onReview: Boolean get() = hasReview && index == questionCount

    /** True when every question has an answer: the only time the review card may send. */
    val canSend: Boolean get() = flow.answers() != null

    /** The next card, whether or not this question is answered; false when there is none. */
    fun next(): Boolean {
        val last = if (hasReview) questionCount else questionCount - 1
        if (index >= last) return false
        index++
        return true
    }

    /** The card before this one; false on Q1, where BACK closes the deck instead. */
    fun previous(): Boolean {
        if (index == 0) return false
        index--
        return true
    }

    /** Opens question [question] (0-based), as a tap on a review row does; a number outside the deck is ignored. */
    fun jump(question: Int) {
        if (question in 0 until questionCount) index = question
    }

    /**
     * `Q<n> <question>: <answer>` for the review card, the answer as the card will
     * send it (a multi-select joined), or `— not answered`.
     */
    fun reviewLine(question: Int): String {
        val item = flow.payload.items[question]
        return "Q${question + 1} ${item.text}: ${answerText(question)}"
    }

    /**
     * [reviewLine] as the one row the review card gives it: the question cut, the
     * answer condensed to [PREVIEW_WORDS] words, the row within the card's line cap.
     */
    fun reviewPreview(question: Int): String {
        val item = flow.payload.items[question]
        val answer = if (flow.isAnswered(question)) {
            VoiceCondense.condense(answerText(question), PREVIEW_WORDS).display
        } else {
            NOT_ANSWERED
        }
        return "Q${question + 1} ${item.text.singleLine(PREVIEW_QUESTION_CHARS)}: $answer".singleLine(BoardCards.MENU_LINE_CHARS)
    }

    /** True when [reviewPreview] is all of [reviewLine]; otherwise the review card offers the rest in the reader. */
    fun previewIsWhole(question: Int): Boolean =
        reviewPreview(question) == reviewLine(question).singleLine(Int.MAX_VALUE)

    private fun answerText(question: Int): String {
        if (!flow.isAnswered(question)) return NOT_ANSWERED
        val item = flow.payload.items[question]
        val picked = item.options.filterIndexed { option, _ -> flow.isPicked(question, option) }.map { it.label }
        return (picked + listOfNotNull(flow.freeText(question))).joinToString(", ")
    }

    companion object {
        const val NOT_ANSWERED = "— not answered"
        const val PREVIEW_WORDS = 12
        private const val PREVIEW_QUESTION_CHARS = 60
    }
}
