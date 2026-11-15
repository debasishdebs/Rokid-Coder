package com.anezium.rokidbus.plugin.agents

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.anezium.rokidbus.plugin.agents.onboarding.OnboardingActivity
import com.anezium.rokidbus.plugin.agents.onboarding.OnboardingStore

/**
 * The launcher entry, and the notification's tap: the guided setup at its first incomplete step
 * until every step is done, the home screen after. It draws nothing itself.
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val next = if (OnboardingStore(this).isDone()) AgentsSettingsActivity::class.java else OnboardingActivity::class.java
        startActivity(Intent(this, next))
        finish()
    }
}
