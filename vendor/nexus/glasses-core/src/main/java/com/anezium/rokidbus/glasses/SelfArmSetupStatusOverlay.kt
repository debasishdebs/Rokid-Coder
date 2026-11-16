package com.anezium.rokidbus.glasses

import android.accessibilityservice.AccessibilityService
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import com.anezium.rokidbus.client.ui.BusTheme

/**
 * The line on the lens while the setup automator drives Settings, so the wearer who sees pages
 * open and close by themselves knows the app is doing it and has not broken. It takes no touch and
 * no focus, so it neither blocks the automator's gestures nor changes what it reads, and it never
 * carries a pairing code or any other digit.
 */
internal class SelfArmSetupStatusOverlay(private val service: AccessibilityService) {
    private var view: TextView? = null

    fun show() {
        if (view != null) return
        val manager = service.getSystemService(WindowManager::class.java) ?: return
        val line = TextView(service).apply {
            text = service.getString(R.string.setup_status_line, service.getString(R.string.product_name))
            setTextColor(BusTheme.phosphor)
            textSize = 13f
            gravity = Gravity.CENTER
            val horizontal = BusTheme.dp(service, 10)
            val vertical = BusTheme.dp(service, 6)
            setPadding(horizontal, vertical, horizontal, vertical)
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(0xFF000000.toInt())
                setStroke(BusTheme.dp(service, 1), BusTheme.hairline)
                cornerRadius = BusTheme.dp(service, 7).toFloat()
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = BusTheme.dp(service, 12)
        }
        if (runCatching { manager.addView(line, params) }.isSuccess) view = line
    }

    fun hide() {
        val line = view ?: return
        view = null
        runCatching { service.getSystemService(WindowManager::class.java)?.removeView(line) }
    }
}
