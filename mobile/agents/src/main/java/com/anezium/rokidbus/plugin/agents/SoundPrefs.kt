package com.anezium.rokidbus.plugin.agents

/** What the phone does when an alert of one state arrives (U19). */
enum class SoundChoice(val wire: String) {
    SPEAK("speak"),
    CHIME("chime"),
    SILENT("silent"),
    ;

    companion object {
        fun fromWire(value: String?): SoundChoice? = values().firstOrNull { it.wire == value }
    }
}

/** The alert states that have a sound setting: the four kinds that sound, and the reminder. */
enum class SoundSlot(val key: String, val label: String, val default: SoundChoice) {
    APPROVAL("sound.approval", "Approval", SoundChoice.SPEAK),
    QUESTION("sound.question", "Question", SoundChoice.SPEAK),
    ERROR("sound.error", "Error", SoundChoice.SPEAK),
    DONE("sound.done", "Done", SoundChoice.CHIME),
    REMINDER("sound.reminder", "Reminder", SoundChoice.SILENT),
}

/** The wearer's choice for each [SoundSlot]; the defaults are U3 and U1 (the reminder is silent). */
data class SoundPrefs(
    val approval: SoundChoice = SoundSlot.APPROVAL.default,
    val question: SoundChoice = SoundSlot.QUESTION.default,
    val error: SoundChoice = SoundSlot.ERROR.default,
    val done: SoundChoice = SoundSlot.DONE.default,
    val reminder: SoundChoice = SoundSlot.REMINDER.default,
) {
    operator fun get(slot: SoundSlot): SoundChoice = when (slot) {
        SoundSlot.APPROVAL -> approval
        SoundSlot.QUESTION -> question
        SoundSlot.ERROR -> error
        SoundSlot.DONE -> done
        SoundSlot.REMINDER -> reminder
    }

    fun with(slot: SoundSlot, choice: SoundChoice): SoundPrefs = when (slot) {
        SoundSlot.APPROVAL -> copy(approval = choice)
        SoundSlot.QUESTION -> copy(question = choice)
        SoundSlot.ERROR -> copy(error = choice)
        SoundSlot.DONE -> copy(done = choice)
        SoundSlot.REMINDER -> copy(reminder = choice)
    }
}
