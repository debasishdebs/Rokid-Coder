package com.anezium.rokidbus.plugin.agents.onboarding

import android.content.Context
import android.content.SharedPreferences
import com.anezium.rokidbus.plugin.agents.AgentProvider

/** The guided setup of §2, in order. DONE is reached only when every step before it is complete. */
enum class OnboardingStep {
    WELCOME,
    PERMISSIONS,
    GLASSES,
    COMPUTER_CHECKLIST,
    FINISH_ON_COMPUTER,
    PAIRING,
    LAPTOP_DONE,
    TEST_ALERT,
    SOUNDS,
    DONE,
}

/** "Which do you use?" It picks the copy and the provider of the test alert. */
enum class ComputerChoice(val label: String) {
    CLAUDE_CODE("Claude Code"),
    CODEX("Codex"),
    BOTH("Both"),
    NEITHER("Neither"),
    ;

    val testAlertProvider: AgentProvider get() = if (this == CODEX) AgentProvider.CODEX else AgentProvider.CLAUDE
}

/**
 * Where the setup is. Every write is a `commit()`: a step recorded complete, the computer choice
 * and the pairing baseline all have to survive the process dying the moment after.
 */
class OnboardingStore internal constructor(private val prefs: SharedPreferences) {
    constructor(context: Context) : this(context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE))

    fun isComplete(step: OnboardingStep): Boolean =
        if (step == OnboardingStep.DONE) STEPS.all(::isComplete) else prefs.getBoolean(key(step), false)

    fun complete(vararg steps: OnboardingStep): Boolean {
        val editor = prefs.edit()
        steps.filter { it != OnboardingStep.DONE }.forEach { editor.putBoolean(key(it), true) }
        return editor.commit()
    }

    /** The first step not yet complete, or DONE. */
    fun firstIncomplete(): OnboardingStep = STEPS.firstOrNull { !isComplete(it) } ?: OnboardingStep.DONE

    /**
     * Where a fresh start of the app opens. FINISH_ON_COMPUTER and PAIRING are one screen, and a
     * pairing window never outlives the process, so an unfinished PAIRING opens as FINISH_ON_COMPUTER.
     */
    fun resumeStep(): OnboardingStep = when (val first = firstIncomplete()) {
        OnboardingStep.PAIRING -> OnboardingStep.FINISH_ON_COMPUTER
        else -> first
    }

    fun isDone(): Boolean = firstIncomplete() == OnboardingStep.DONE

    /**
     * Whether an app foreground may start the service: from the GLASSES step on, once the
     * permissions it runs under have been asked. Before that, nothing runs in the background.
     */
    fun serviceAllowed(): Boolean = isComplete(OnboardingStep.WELCOME) && isComplete(OnboardingStep.PERMISSIONS)

    var computerChoice: ComputerChoice?
        get() = prefs.getString(KEY_CHOICE, null)?.let { name -> ComputerChoice.values().firstOrNull { it.name == name } }
        set(value) {
            prefs.edit().putString(KEY_CHOICE, value?.name).commit()
        }

    /** A permission screen was shown and answered; the PERMISSIONS step needs every one. */
    fun permissionAsked(id: String): Boolean = prefs.getBoolean("$KEY_ASKED_PREFIX$id", false)

    fun markPermissionAsked(id: String): Boolean = prefs.edit().putBoolean("$KEY_ASKED_PREFIX$id", true).commit()

    /**
     * `OnboardingPairing{baselineMachineIds}`: every computer the phone held when the pairing
     * screen was first entered. Only a computer outside it completes LAPTOP_DONE.
     */
    fun pairingBaseline(): Set<String>? =
        if (prefs.getBoolean(KEY_BASELINE_SET, false)) prefs.getStringSet(KEY_BASELINE, emptySet()).orEmpty().toSet() else null

    /** Records [machineIds] unless a baseline is already recorded, and returns the one in force. */
    fun recordPairingBaseline(machineIds: Set<String>): Set<String> {
        pairingBaseline()?.let { return it }
        prefs.edit().putStringSet(KEY_BASELINE, machineIds.toSet()).putBoolean(KEY_BASELINE_SET, true).commit()
        return machineIds
    }

    /** The last step: SOUNDS completes, and the baseline goes with it. */
    fun finish(): Boolean = prefs.edit()
        .putBoolean(key(OnboardingStep.SOUNDS), true)
        .remove(KEY_BASELINE)
        .remove(KEY_BASELINE_SET)
        .commit()

    private fun key(step: OnboardingStep) = "$KEY_STEP_PREFIX${step.name}"

    companion object {
        const val PREFS = "coder_onboarding"
        private const val KEY_STEP_PREFIX = "step."
        private const val KEY_CHOICE = "computer_choice"
        private const val KEY_ASKED_PREFIX = "asked."
        private const val KEY_BASELINE = "pairing.baseline"
        private const val KEY_BASELINE_SET = "pairing.baseline_set"

        /** Every step that must complete; DONE is their conjunction. */
        val STEPS = OnboardingStep.values().filter { it != OnboardingStep.DONE }
    }
}
