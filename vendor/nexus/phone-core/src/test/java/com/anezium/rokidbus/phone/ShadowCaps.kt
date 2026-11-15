package com.anezium.rokidbus.phone

import com.rokid.cxr.Caps
import org.json.JSONArray
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject

/**
 * The vendor Caps framing is native; tests frame its string values as a JSON array instead. Only
 * strings cross the bus, so nothing else is supported.
 */
@Implements(Caps::class)
class ShadowCaps {
    @RealObject
    private lateinit var real: Caps

    @Implementation
    fun serialize(): ByteArray {
        val array = JSONArray()
        for (index in 0 until real.size()) array.put(real.at(index).string)
        return array.toString().toByteArray(Charsets.UTF_8)
    }

    @Implementation
    fun parse(bytes: ByteArray, offset: Int, length: Int): Boolean {
        val array = runCatching { JSONArray(String(bytes, offset, length, Charsets.UTF_8)) }.getOrNull()
            ?: return false
        for (index in 0 until array.length()) real.write(array.getString(index))
        return true
    }
}
