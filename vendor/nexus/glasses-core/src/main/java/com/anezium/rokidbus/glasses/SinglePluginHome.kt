package com.anezium.rokidbus.glasses

/**
 * What the launcher activity does in an app that hosts one plugin (a shell sets
 * `launcher_single_plugin_app`): it opens that plugin's surface as soon as the phone has listed
 * it, and when that surface closes the app is left instead of showing the one-row list again.
 * An app with two or more plugin surfaces, and upstream's own hub, keep the list.
 */
internal class SinglePluginHome(
    private val enabled: Boolean,
    private val opensSurface: (String) -> Boolean = GlassesHub::launcherEntryOpensSurface,
) {
    private var openedPluginId: String? = null
    private var surfaceSeen = false

    /** True once the plugin's surface has been shown and has since closed. */
    var leaving: Boolean = false
        private set

    /**
     * The entry to open for [entries], or null: not a single-plugin app, already opened, or not
     * exactly one plugin surface listed. Native-surface entries such as the camera do not count.
     */
    fun entryToOpen(entries: List<GlassesHub.LauncherEntry>): GlassesHub.LauncherEntry? {
        if (!enabled || openedPluginId != null || leaving) return null
        return entries.filter { opensSurface(it.id) }.singleOrNull()
    }

    /** Records that opening [entry] was sent, so the same list is not opened twice. */
    fun opened(entry: GlassesHub.LauncherEntry) {
        openedPluginId = entry.id
        surfaceSeen = false
    }

    /** The launcher was brought forward again (the wearer opened the app anew). */
    fun reset() {
        openedPluginId = null
        surfaceSeen = false
        leaving = false
    }

    /**
     * Feeds whether a surface is on the display. The app hosts one plugin, so any surface after
     * the open is that plugin's. True when the app should be left now.
     */
    fun onSurface(shown: Boolean): Boolean {
        if (openedPluginId == null) return false
        if (shown) {
            surfaceSeen = true
            return false
        }
        if (!surfaceSeen) return false
        leaving = true
        return true
    }
}
