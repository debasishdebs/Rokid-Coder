package com.anezium.rokidbus.glasses

import com.anezium.rokidbus.shared.BusCapabilityBits
import com.anezium.rokidbus.shared.GlassesHubCapabilitiesContract
import com.anezium.rokidbus.shared.NoticeField
import com.anezium.rokidbus.shared.NoticeInteractionIdentity
import com.anezium.rokidbus.shared.NoticeSurfaceContent
import com.anezium.rokidbus.shared.NoticeSurfaceContract
import com.anezium.rokidbus.shared.NoticeSurfacePatch
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NoticeShownAckTest {
    private val sent = mutableListOf<JSONObject>()
    private var transportUp = true
    private val reporter = NoticeShownReporter { payload ->
        if (transportUp) sent += payload
        transportUp
    }

    @Test
    fun shown_emitted_once_per_show_when_attached_and_phone_supports_ack() {
        val state = NoticeStateMachine()
        val first = identity("instance-a", "question-a")
        val shown = (state.show("agents:notice", 1, content(), 0L, interactionIdentity = first)
            as NoticeStateDecision.Shown).notice

        reporter.bandAttached(shown, phoneSupportsAck = true)
        // Every later render of the same band is the same show: a selection
        // move, a text update, and a rearm that asks a new question in place.
        reporter.bandAttached(shown.copy(selectedActionIndex = 1), phoneSupportsAck = true)
        val rearmed = (state.update(
            "agents:notice",
            2,
            NoticeSurfacePatch(interactive = NoticeField(true)),
            0L,
            identity("instance-a", "question-b"),
        ) as NoticeStateDecision.Updated).notice
        reporter.bandAttached(rearmed, phoneSupportsAck = true)

        assertEquals(1, sent.size)
        assertEquals("agents:notice", sent.single().getString("noticeId"))
        assertEquals(first, NoticeSurfaceContract.interactionIdentity(sent.single()))

        // A transport that did not take the report leaves it owed.
        val second = identity("instance-b", "question-c")
        val reshown = (state.show("agents:notice", 3, content(), 0L, interactionIdentity = second)
            as NoticeStateDecision.Shown).notice
        transportUp = false
        reporter.bandAttached(reshown, phoneSupportsAck = true)
        transportUp = true
        reporter.bandAttached(reshown, phoneSupportsAck = true)
        reporter.bandAttached(reshown, phoneSupportsAck = true)

        assertEquals(2, sent.size)
        assertEquals(second, NoticeSurfaceContract.interactionIdentity(sent.last()))
    }

    @Test
    fun not_emitted_without_phone_capability() {
        val notice = (NoticeStateMachine().show(
            "agents:notice",
            1,
            content(),
            0L,
            interactionIdentity = identity("instance-a", "question-a"),
        ) as NoticeStateDecision.Shown).notice

        reporter.bandAttached(notice, phoneSupportsAck = false)
        // A band without an interaction identity has nothing the phone could match.
        reporter.bandAttached(notice.copy(interactionIdentity = null), phoneSupportsAck = true)

        assertTrue(sent.isEmpty())
    }

    @Test
    fun glasses_capabilities_advertise_notice_shown_ack() {
        for (ttsAvailable in listOf(true, false)) {
            val features = glassesHubFeatures(ttsAvailable)
            assertTrue(features and BusCapabilityBits.NOTICE_SHOWN_ACK != 0)
            val announced = GlassesHubCapabilitiesContract.parse(
                GlassesHubCapabilitiesContract.toJson(
                    GlassesHubCapabilitiesContract.create(
                        features = features,
                        imageSurfaceVersion = 0,
                        noticeSurfaceVersion = NoticeSurfaceContract.VERSION,
                        maxImageBytes = 0,
                        versionName = null,
                    ),
                ),
            )
            assertTrue(GlassesHubCapabilitiesContract.supportsNoticeShownAck(announced))
        }
        // The notice tier itself is unchanged, so stock phones keep pairing.
        assertEquals(5, NoticeSurfaceContract.VERSION)
    }

    private fun identity(instance: String, question: String) =
        NoticeInteractionIdentity(instance, question)

    private fun content() = NoticeSurfaceContent(
        title = "CLAUDE · approve",
        body = "rm -rf build",
        footer = null,
    )
}
