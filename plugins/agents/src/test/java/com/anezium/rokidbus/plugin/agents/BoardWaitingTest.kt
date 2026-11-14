package com.anezium.rokidbus.plugin.agents

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class BoardWaitingTest {
    private class Glasses : AlertGlasses {
        override fun showBand(notice: com.anezium.rokidbus.client.plugin.NexusNotice) = true
        override fun updateBand(update: com.anezium.rokidbus.client.plugin.NexusNoticeUpdate) = true
        override fun hideBand() = Unit
        override fun brief(title: String, body: String) = Unit
        override fun openOutput(alert: AgentdAction.Alert) = Unit
        override fun openDecision(alert: AgentdAction.Alert) = Unit
        override fun openQuestion(alert: AgentdAction.Alert) = Unit
        override fun invalidate(alertId: String) = Unit
    }

    private val glasses = Glasses()
    private val director = AlertDirector(
        coordinator = AlertCoordinator(clock = { 0L }),
        write = {},
        secure = { true },
        glasses = { glasses },
        post = { it() },
    )

    private fun alert(reason: String, waiting: Int) = AgentdProtocolCodec().parse(
        JSONObject()
            .put("type", "alert").put("v", 2).put("id", "A").put("sessionKey", "claude:s1")
            .put("kind", "approval").put("title", "t").put("body", "b")
            .put("actions", JSONArray(listOf("allow", "deny")))
            .put("waiting", waiting).put("reason", reason)
            .toString(),
    ) as AgentdAction.Alert

    private fun feed(alert: AgentdAction.Alert) = director.onEvent(AgentdEvent.Action(alert))

    /** The board redraws on each new value of this flow, so its values are the redraws. */
    @Test
    fun waiting_change_redraws_board() {
        assertEquals(0, director.waiting.value)

        director.onEvent(AgentdEvent.LinkUp(1L, true))
        feed(alert("new", waiting = 2))
        assertEquals(2, director.waiting.value)

        feed(alert("update", waiting = 3))
        assertEquals(3, director.waiting.value)

        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("A", "resolved")))
        assertEquals(0, director.waiting.value)

        feed(alert("new", waiting = 1))
        director.onEvent(AgentdEvent.LinkUp(2L, true))
        assertEquals(0, director.waiting.value)
    }
}
