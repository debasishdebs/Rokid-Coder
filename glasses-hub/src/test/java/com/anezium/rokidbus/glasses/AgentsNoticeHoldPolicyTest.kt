package com.anezium.rokidbus.glasses

import com.anezium.rokidbus.shared.NoticeAction
import com.anezium.rokidbus.shared.NoticeCloseReason
import com.anezium.rokidbus.shared.NoticeSurfaceContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentsNoticeHoldPolicyTest {
    @Test
    fun agents_band_with_actions_engages_hold() {
        for (actionCount in listOf(1, 2, 3)) {
            assertTrue(NoticeDisplayHoldPolicy.agentsNoticeHoldsDisplay(AGENTS_NOTICE, actionCount))
            assertEquals(
                AssistantEpisodeSignal.Engage(7L),
                agentsEpisodeNoticeShownSignal(AGENTS_NOTICE, actionCount, seq = 7L),
            )
        }
        val harness = Harness()

        val shown = harness.apply(agentsApproval(seq = 1L), nowMs = 0L)

        val acquire = shown.single() as DisplayHoldTransition.Acquire
        assertEquals(AgentsDisplayEpisode.OWNER_ID, acquire.ownerId)
        assertEquals(90_000L, acquire.leaseMs)
        assertEquals("agents:episode", harness.lifecycle.snapshot()?.ownerId)
    }

    @Test
    fun agents_band_without_actions_does_not_hold() {
        assertFalse(NoticeDisplayHoldPolicy.agentsNoticeHoldsDisplay(AGENTS_NOTICE, 0))
        assertEquals(
            AssistantEpisodeSignal.None,
            agentsEpisodeNoticeShownSignal(AGENTS_NOTICE, actionCount = 0, seq = 1L),
        )
        val harness = Harness()

        assertTrue(harness.apply(agentsShown(actionCount = 0, seq = 1L), nowMs = 0L).isEmpty())
        assertNull(harness.lifecycle.snapshot())
        assertEquals(0, harness.leases.size)
    }

    @Test
    fun other_plugin_band_with_actions_does_not_hold() {
        for (surfaceId in listOf("assistant:notice", "relay:notice", "agents:activity", "")) {
            assertFalse(surfaceId, NoticeDisplayHoldPolicy.agentsNoticeHoldsDisplay(surfaceId, 3))
            assertEquals(
                surfaceId,
                AssistantEpisodeSignal.None,
                agentsEpisodeNoticeShownSignal(surfaceId, actionCount = 3, seq = 1L),
            )
            assertEquals(
                surfaceId,
                AssistantEpisodeSignal.None,
                agentsEpisodeNoticeClosedSignal(surfaceId, NoticeCloseReason.USER),
            )
            assertEquals(
                surfaceId,
                AssistantEpisodeSignal.None,
                agentsEpisodeNoticeRedrawSignal(
                    surfaceId,
                    actionCount = 0,
                    seq = 1L,
                    reason = DisplayHoldRenewReason.BAND_UPDATE,
                ),
            )
        }
    }

    @Test
    fun assistant_behaviour_unchanged() {
        // An Agents approval leaves `interactive` false, so the Assistant
        // signals see it exactly as before: not theirs, and not a takeover.
        assertEquals(
            AssistantEpisodeSignal.None,
            assistantEpisodeNoticeShownSignal(
                surfaceId = AGENTS_NOTICE,
                ownerPluginId = AGENTS_PLUGIN,
                seq = 1L,
                engaged = false,
            ),
        )
        assertEquals(
            AssistantEpisodeSignal.End(DisplayHoldReleaseReason.ENGAGED_NOTICE_TAKEOVER),
            assistantEpisodeNoticeShownSignal(
                surfaceId = AGENTS_NOTICE,
                ownerPluginId = AGENTS_PLUGIN,
                seq = 1L,
                engaged = true,
            ),
        )
        assertEquals(
            AssistantEpisodeSignal.Engage(2L),
            assistantEpisodeNoticeShownSignal(
                surfaceId = ASSISTANT_NOTICE,
                ownerPluginId = ASSISTANT_PLUGIN,
                seq = 2L,
                engaged = true,
            ),
        )
        assertTrue(NoticeDisplayHoldPolicy.noticeHoldsDisplay(ASSISTANT_NOTICE, engaged = true))
        assertFalse(NoticeDisplayHoldPolicy.noticeHoldsDisplay(AGENTS_NOTICE, engaged = true))
        for (reason in NoticeCloseReason.entries) {
            assertEquals(
                reason.name,
                AssistantEpisodeSignal.None,
                assistantEpisodeNoticeClosedSignal(
                    surfaceId = AGENTS_NOTICE,
                    reason = reason,
                    preserveOwnerClose = false,
                ),
            )
        }
        assertEquals(
            AssistantEpisodeSignal.None,
            assistantEpisodeNoticeClosedSignal(
                surfaceId = ASSISTANT_NOTICE,
                reason = NoticeCloseReason.TIMEOUT,
                preserveOwnerClose = false,
            ),
        )
        assertEquals(
            AssistantEpisodeSignal.None,
            assistantEpisodeSurfacePresentedSignal(ASSISTANT_PLUGIN),
        )
        assertEquals("assistant:episode", AssistantDisplayEpisode.OWNER_ID)
        assertEquals(90_000L, AssistantDisplayEpisode.DISPLAY_HOLD_CEILING_MS)
    }

    @Test
    fun agents_hold_ends_on_user_owner_timeout_replaced_disconnect() {
        val expected = mapOf(
            NoticeCloseReason.USER to DisplayHoldReleaseReason.WEARER_DISMISSED,
            NoticeCloseReason.OWNER to DisplayHoldReleaseReason.SESSION_CLOSED,
            NoticeCloseReason.TIMEOUT to DisplayHoldReleaseReason.NOTICE_EXPIRED,
            NoticeCloseReason.REPLACED to DisplayHoldReleaseReason.NOTICE_REPLACED,
            NoticeCloseReason.DISCONNECT to DisplayHoldReleaseReason.LINK_LOSS,
        )
        assertEquals(NoticeCloseReason.entries.toSet(), expected.keys)
        for ((closeReason, releaseReason) in expected) {
            val harness = Harness()
            harness.apply(agentsApproval(seq = 1L), nowMs = 0L)

            val closed = harness.apply(
                agentsEpisodeNoticeClosedSignal(AGENTS_NOTICE, closeReason),
                nowMs = 10_000L,
            )

            assertEquals(closeReason.name, releaseReason, release(closed).reason)
            assertEquals(closeReason.name, 1, harness.leases.single().releases)
            assertNull(closeReason.name, harness.lifecycle.snapshot())
        }
    }

    @Test
    fun agents_hold_ends_when_redrawn_without_actions() {
        val harness = Harness()
        harness.apply(agentsApproval(seq = 1L), nowMs = 0L)

        val withActions = harness.apply(agentsRedraw(actionCount = 3, seq = 2L), nowMs = 10_000L)
        val withoutActions = harness.apply(agentsRedraw(actionCount = 0, seq = 3L), nowMs = 20_000L)

        assertEquals(DisplayHoldRenewReason.BAND_UPDATE, renew(withActions).reason)
        assertEquals(DisplayHoldReleaseReason.NO_ACTIONS, release(withoutActions).reason)
        assertNull(harness.lifecycle.snapshot())
        assertEquals(1, harness.leases.single().releases)
    }

    @Test
    fun surface_update_does_not_end_agents_hold() {
        val harness = Harness()
        harness.apply(agentsApproval(seq = 1L), nowMs = 0L)

        val update = harness.apply(
            agentsEpisodeSurfacePresentedSignal(isHandoff = false),
            nowMs = 10_000L,
        )

        assertTrue(update.isEmpty())
        assertEquals(AgentsDisplayEpisode.OWNER_ID, harness.lifecycle.snapshot()?.ownerId)
        assertEquals(0, harness.leases.single().releases)
    }

    @Test
    fun new_surface_handoff_ends_agents_hold() {
        val harness = Harness()
        harness.apply(agentsApproval(seq = 1L), nowMs = 0L)

        val handoff = harness.apply(
            agentsEpisodeSurfacePresentedSignal(isHandoff = true),
            nowMs = 10_000L,
        )

        assertEquals(DisplayHoldReleaseReason.SURFACE_PRESENTED, release(handoff).reason)
        assertNull(harness.lifecycle.snapshot())
        assertEquals(1, harness.leases.single().releases)
    }

    @Test
    fun answered_band_ends_agents_hold() {
        val harness = Harness()
        val band = agentsBand(seq = 1L)
        harness.applyAll(noticeEpisodeSignals(NoticeStateDecision.Shown(band)), nowMs = 0L)

        val answered = noticeEpisodeSignals(
            NoticeStateDecision.Answered(
                band.copy(answered = true),
                NoticeAnswer.Action(band.content.actions.first()),
            ),
        )
        val transitions = harness.applyAll(answered, nowMs = 10_000L)

        assertEquals(
            listOf(
                DisplayEpisodeOwner.AGENTS to
                    AssistantEpisodeSignal.End(DisplayHoldReleaseReason.NO_ACTIONS),
            ),
            answered,
        )
        assertEquals(DisplayHoldReleaseReason.NO_ACTIONS, release(transitions).reason)
        assertNull(harness.lifecycle.snapshot())
        assertEquals(1, harness.leases.single().releases)
    }

    @Test
    fun notice_wiring_ends_a_replaced_agents_band_before_any_engage() {
        val replacement = agentsBand(seq = 2L)

        val signals = noticeEpisodeSignals(
            NoticeStateDecision.Shown(replacement, replacedNotice = agentsBand(seq = 1L)),
        )

        assertEquals(
            listOf(
                DisplayEpisodeOwner.AGENTS to
                    AssistantEpisodeSignal.End(DisplayHoldReleaseReason.NOTICE_REPLACED),
                DisplayEpisodeOwner.ASSISTANT to
                    AssistantEpisodeSignal.End(DisplayHoldReleaseReason.ENGAGED_NOTICE_TAKEOVER),
                DisplayEpisodeOwner.AGENTS to AssistantEpisodeSignal.Engage(2L),
            ),
            signals,
        )
    }

    @Test
    fun notice_wiring_sends_the_takeover_before_the_assistant_engage() {
        val assistantBand = agentsBand(seq = 3L).copy(
            surfaceId = ASSISTANT_NOTICE,
            ownerPluginId = ASSISTANT_PLUGIN,
            content = agentsBand(seq = 3L).content.copy(interactive = true, actions = emptyList()),
        )

        val signals = noticeEpisodeSignals(
            NoticeStateDecision.Shown(assistantBand, replacedNotice = agentsBand(seq = 2L)),
        )

        assertEquals(
            listOf(
                DisplayEpisodeOwner.AGENTS to
                    AssistantEpisodeSignal.End(DisplayHoldReleaseReason.NOTICE_REPLACED),
                DisplayEpisodeOwner.AGENTS to
                    AssistantEpisodeSignal.End(DisplayHoldReleaseReason.ENGAGED_NOTICE_TAKEOVER),
                DisplayEpisodeOwner.ASSISTANT to AssistantEpisodeSignal.Engage(3L),
            ),
            signals,
        )
    }

    @Test
    fun notice_wiring_ends_agents_hold_on_close() {
        for (reason in NoticeCloseReason.entries) {
            val signals = noticeEpisodeSignals(
                NoticeStateDecision.Closed(
                    surfaceId = AGENTS_NOTICE,
                    seq = 1L,
                    ttlMs = 45_000L,
                    reason = reason,
                ),
                preserveOwnerClose = true,
            )

            assertEquals(reason.name, DisplayEpisodeOwner.AGENTS, signals.single().first)
            assertTrue(reason.name, signals.single().second is AssistantEpisodeSignal.End)
        }
    }

    @Test
    fun assistant_engaged_notice_ends_agents_hold_and_vice_versa() {
        val assistant = Harness(AssistantDisplayEpisode.OWNER_ID)
        val agents = Harness(AgentsDisplayEpisode.OWNER_ID)
        val assistantEngage = assistantEpisodeNoticeShownSignal(
            surfaceId = ASSISTANT_NOTICE,
            ownerPluginId = ASSISTANT_PLUGIN,
            seq = 1L,
            engaged = true,
        )
        assistant.apply(assistantEngage, nowMs = 0L)

        val agentsEngage = agentsApproval(seq = 2L)
        val assistantTakeover = assistant.apply(
            displayEpisodeTakeoverSignal(agentsEngage),
            nowMs = 5_000L,
        )
        agents.apply(agentsEngage, nowMs = 5_000L)

        assertEquals(
            DisplayHoldReleaseReason.ENGAGED_NOTICE_TAKEOVER,
            release(assistantTakeover).reason,
        )
        assertNull(assistant.lifecycle.snapshot())
        assertEquals(AgentsDisplayEpisode.OWNER_ID, agents.lifecycle.snapshot()?.ownerId)

        val agentsTakeover = agents.apply(
            displayEpisodeTakeoverSignal(assistantEngage),
            nowMs = 10_000L,
        )
        assistant.apply(assistantEngage, nowMs = 10_000L)

        assertEquals(
            DisplayHoldReleaseReason.ENGAGED_NOTICE_TAKEOVER,
            release(agentsTakeover).reason,
        )
        assertNull(agents.lifecycle.snapshot())
        assertEquals(AssistantDisplayEpisode.OWNER_ID, assistant.lifecycle.snapshot()?.ownerId)

        assertEquals(
            AssistantEpisodeSignal.None,
            displayEpisodeTakeoverSignal(agentsShown(actionCount = 0, seq = 3L)),
        )
        assertEquals(
            AssistantEpisodeSignal.None,
            displayEpisodeTakeoverSignal(agentsRedraw(actionCount = 3, seq = 3L)),
        )
    }

    @Test
    fun agents_hold_capped_at_90s() {
        assertEquals(90_000L, AgentsDisplayEpisode.DISPLAY_HOLD_CEILING_MS)
        val harness = Harness()
        harness.apply(agentsApproval(seq = 1L), nowMs = 0L)

        // Unanswered `+N waiting` updates re-assert what is left, never more.
        val update = harness.apply(agentsRedraw(actionCount = 3, seq = 2L), nowMs = 30_000L)
        val laterUpdate = harness.apply(agentsRedraw(actionCount = 3, seq = 3L), nowMs = 60_000L)

        assertEquals(60_000L, renew(update).leaseMs)
        assertEquals(30_000L, renew(laterUpdate).leaseMs)
        assertEquals(90_000L, harness.lifecycle.snapshot()?.deadlineAtMs)

        val ceiling = harness.lifecycle.enforceCeiling(
            episodeId = harness.lifecycle.snapshot()!!.episodeId,
            deadlineAtMs = 90_000L,
            nowMs = 90_000L,
        )
        val redrawAfterCeiling = harness.apply(
            agentsRedraw(actionCount = 3, seq = 4L),
            nowMs = 91_000L,
        )

        assertEquals(DisplayHoldReleaseReason.SAFETY_CEILING, ceiling?.reason)
        assertTrue(redrawAfterCeiling.isEmpty())
        assertNull(harness.lifecycle.snapshot())
        assertEquals(listOf(90_000L, 60_000L, 30_000L), harness.leases.single().acquisitions)
        assertEquals(1, harness.leases.single().releases)
    }

    private fun agentsApproval(seq: Long): AssistantEpisodeSignal =
        agentsShown(actionCount = 3, seq = seq)

    private fun agentsShown(actionCount: Int, seq: Long): AssistantEpisodeSignal =
        agentsEpisodeNoticeShownSignal(AGENTS_NOTICE, actionCount, seq)

    private fun agentsRedraw(actionCount: Int, seq: Long): AssistantEpisodeSignal =
        agentsEpisodeNoticeRedrawSignal(
            AGENTS_NOTICE,
            actionCount = actionCount,
            seq = seq,
            reason = DisplayHoldRenewReason.BAND_UPDATE,
        )

    private fun agentsBand(seq: Long) = NexusNoticeSurface(
        surfaceId = AGENTS_NOTICE,
        seq = seq,
        content = NoticeSurfaceContent(
            title = "Approve Bash?",
            body = "rm -rf build",
            footer = null,
            actions = listOf(
                NoticeAction("allow", "check", "Allow"),
                NoticeAction("deny", "close", "Deny"),
                NoticeAction("more", "more", "More"),
            ),
            ttlMs = 45_000L,
        ),
        expiresAtMs = 45_000L,
        hardExpiresAtMs = 45_000L,
        ownerPluginId = AGENTS_PLUGIN,
    )

    private fun renew(transitions: List<DisplayHoldTransition>): DisplayHoldTransition.Renew =
        transitions.single() as DisplayHoldTransition.Renew

    private fun release(transitions: List<DisplayHoldTransition>): DisplayHoldTransition.Release =
        transitions.single() as DisplayHoldTransition.Release

    private class Harness(ownerId: String = AgentsDisplayEpisode.OWNER_ID) {
        val lifecycle = AssistantEpisodeHoldLifecycle(
            ceilingMs = AgentsDisplayEpisode.DISPLAY_HOLD_CEILING_MS,
            ownerId = ownerId,
        )
        val leases = mutableListOf<FakeLease>()

        fun apply(signal: AssistantEpisodeSignal, nowMs: Long): List<DisplayHoldTransition> =
            lifecycle.apply(signal, nowMs) { FakeLease().also(leases::add) }

        fun applyAll(
            signals: List<Pair<DisplayEpisodeOwner, AssistantEpisodeSignal>>,
            nowMs: Long,
        ): List<DisplayHoldTransition> = signals
            .filter { (owner, _) -> owner == DisplayEpisodeOwner.AGENTS }
            .flatMap { (_, signal) -> apply(signal, nowMs) }
    }

    private class FakeLease : DisplayHoldLease {
        val acquisitions = mutableListOf<Long>()
        var releases = 0

        override fun acquire(timeoutMs: Long) {
            acquisitions += timeoutMs
        }

        override fun release() {
            releases += 1
        }
    }

    private companion object {
        const val AGENTS_PLUGIN = "agents"
        const val AGENTS_NOTICE = "agents:notice"
        const val ASSISTANT_PLUGIN = "assistant"
        const val ASSISTANT_NOTICE = "assistant:notice"
    }
}
