package com.anezium.rokidbus.plugin.agents.onboarding

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.robolectric.shadows.ShadowLooper

/** The texts a screen shows, buttons included, in drawing order. */
internal fun Activity.visibleTexts(): List<String> {
    ShadowLooper.idleMainLooper()
    val out = mutableListOf<String>()
    fun walk(view: View) {
        if (view.visibility != View.VISIBLE) return
        if (view is TextView) out += view.text.toString()
        if (view is ViewGroup) (0 until view.childCount).forEach { walk(view.getChildAt(it)) }
    }
    walk(window.decorView)
    return out
}

internal fun Activity.clickText(text: String) {
    ShadowLooper.idleMainLooper()
    fun find(view: View): View? {
        if (view.visibility != View.VISIBLE) return null
        if (view is TextView && view.text.toString().equals(text, ignoreCase = true) && view.hasOnClickListeners()) return view
        if (view is ViewGroup) (0 until view.childCount).forEach { child -> find(view.getChildAt(child))?.let { return it } }
        return null
    }
    val target = find(window.decorView) ?: error("No clickable \"$text\" on screen: ${visibleTexts()}")
    target.performClick()
    ShadowLooper.idleMainLooper()
}
