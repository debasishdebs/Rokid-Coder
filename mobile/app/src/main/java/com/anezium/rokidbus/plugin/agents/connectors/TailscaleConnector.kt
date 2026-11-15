package com.anezium.rokidbus.plugin.agents.connectors

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.anezium.rokidbus.plugin.agents.LinkKey
import com.anezium.rokidbus.plugin.agents.SecureLink
import java.net.InetAddress

/**
 * The Tailscale connector (U38, §13.2): only what the phone can know. "Connected" is shown only
 * while a secure link to a computer runs over a tailnet address; an installed app proves nothing.
 */
enum class TailscaleStatus(val text: String) {
    NOT_INSTALLED("Not installed"),
    INSTALLED("Installed — open Tailscale to check it's connected"),
    CONNECTED("Connected"),
}

fun tailscaleStatus(installed: Boolean, links: Map<LinkKey, SecureLink>): TailscaleStatus = when {
    !installed -> TailscaleStatus.NOT_INSTALLED
    links.values.any { isTailnetAddress(it.remoteAddress) } -> TailscaleStatus.CONNECTED
    else -> TailscaleStatus.INSTALLED
}

/** Tailscale's ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. Literal addresses only; a name is not resolved. */
fun isTailnetAddress(address: String?): Boolean {
    val text = address?.trim()?.removePrefix("[")?.removeSuffix("]")?.substringBefore('%') ?: return false
    if (text.isEmpty()) return false
    val literal = text.all { it.isDigit() || it == '.' } || (':' in text && text.all { it.isLetterOrDigit() || it == ':' || it == '.' })
    if (!literal) return false
    val bytes = runCatching { InetAddress.getByName(text) }.getOrNull()?.address ?: return false
    return when (bytes.size) {
        4 -> bytes[0] == 100.toByte() && (bytes[1].toInt() and 0xC0) == 0x40
        16 -> TAILNET_V6.indices.all { bytes[it] == TAILNET_V6[it] }
        else -> false
    }
}

private val TAILNET_V6 = byteArrayOf(0xfd.toByte(), 0x7a, 0x11, 0x5c, 0xa1.toByte(), 0xe0.toByte())

object TailscaleConnector {
    const val PACKAGE = "com.tailscale.ipn"
    const val MARKET_URL = "market://details?id=$PACKAGE"
    const val WEB_URL = "https://play.google.com/store/apps/details?id=$PACKAGE"
    const val TITLE = "Tailscale"
    const val INTRO = "Use Rokid Coder away from home: Tailscale links this phone and your computer over the internet."
    val STEPS = listOf("Get Tailscale", "Sign in with the same account on your computer")

    /** Detected through the manifest's `<queries>` entry for the package. */
    fun installed(context: Context): Boolean = runCatching { context.packageManager.getPackageInfo(PACKAGE, 0) }.isSuccess

    fun openStore(activity: Activity) {
        runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(MARKET_URL))) }.onFailure {
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(WEB_URL))) }
        }
    }
}
