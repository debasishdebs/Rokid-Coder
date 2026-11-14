package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionFlowTest {
    private fun item(
        text: String,
        options: List<String> = listOf("Red", "Green", "Blue"),
        multi: Boolean = false,
        free: Boolean = false,
    ) = QuestionItem(text, options.map(::QuestionOption), multi, free)

    private fun flow(vararg items: QuestionItem) =
        QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref-1", "claude_tool", items.toList()))

    @Test
    fun single_select_replaces() {
        val flow = flow(item("Colour?"))
        flow.toggle(0, 0)
        flow.toggle(0, 2)
        assertEquals(mapOf<String, Any>("Colour?" to "Blue"), flow.answers())
        assertFalse(flow.isPicked(0, 0))
        // Picking the same one again keeps it: a single choice cannot be un-chosen into nothing.
        flow.toggle(0, 2)
        assertEquals(mapOf<String, Any>("Colour?" to "Blue"), flow.answers())
    }

    @Test
    fun multi_select_toggles_list() {
        val flow = flow(item("Colours?", multi = true))
        assertNull(flow.answers())
        flow.toggle(0, 2)
        flow.toggle(0, 0)
        assertEquals(mapOf<String, Any>("Colours?" to listOf("Red", "Blue")), flow.answers())
        flow.toggle(0, 2)
        assertEquals(mapOf<String, Any>("Colours?" to listOf("Red")), flow.answers())
        flow.toggle(0, 0)
        assertNull(flow.answers())
    }

    @Test
    fun free_text_only_when_allowed() {
        val closed = flow(item("Colour?"))
        closed.setFreeText(0, "Purple")
        assertNull(closed.freeText(0))
        assertNull(closed.answers())

        val open = flow(item("Colour?", free = true))
        open.setFreeText(0, "  Purple ")
        assertEquals("Purple", open.freeText(0))
        assertEquals(mapOf<String, Any>("Colour?" to "Purple"), open.answers())
    }

    @Test
    fun free_text_and_a_single_pick_replace_each_other() {
        val flow = flow(item("Colour?", free = true))
        flow.toggle(0, 1)
        flow.setFreeText(0, "Purple")
        assertFalse(flow.isPicked(0, 1))
        assertEquals("Purple", flow.answers()?.get("Colour?"))
        flow.toggle(0, 1)
        assertNull(flow.freeText(0))
        assertEquals("Green", flow.answers()?.get("Colour?"))
        // Blank text clears it.
        flow.setFreeText(0, "Teal")
        flow.setFreeText(0, "  ")
        assertNull(flow.answers())
    }

    @Test
    fun multi_select_free_text_joins_the_list() {
        val flow = flow(item("Colours?", multi = true, free = true))
        flow.setFreeText(0, "Teal")
        assertEquals(mapOf<String, Any>("Colours?" to listOf("Teal")), flow.answers())
        flow.toggle(0, 1)
        assertEquals(mapOf<String, Any>("Colours?" to listOf("Green", "Teal")), flow.answers())
    }

    @Test
    fun answers_null_until_all_items_answered() {
        val flow = flow(item("One?"), item("Two?", multi = true), item("Three?", options = emptyList(), free = true))
        assertNull(flow.answers())
        flow.toggle(0, 0)
        assertNull(flow.answers())
        flow.toggle(1, 1)
        assertNull(flow.answers())
        assertTrue(flow.isAnswered(0))
        assertFalse(flow.isAnswered(2))
        flow.setFreeText(2, "because")
        assertEquals(3, flow.answers()?.size)
    }

    @Test
    fun answers_keyed_by_question_text() {
        val flow = flow(item("Which colour?"), item("Which sizes?", options = listOf("S", "M", "L"), multi = true))
        flow.toggle(0, 1)
        flow.toggle(1, 0)
        flow.toggle(1, 2)
        assertEquals(
            mapOf<String, Any>("Which colour?" to "Green", "Which sizes?" to listOf("S", "L")),
            flow.answers(),
        )
    }

    @Test
    fun an_out_of_range_pick_is_ignored() {
        val flow = flow(item("Colour?"))
        flow.toggle(0, 7)
        flow.toggle(3, 0)
        flow.setFreeText(3, "x")
        assertNull(flow.answers())
    }

    @Test
    fun two_items_with_one_text_cannot_be_answered_by_one_key() {
        val flow = flow(item("Same?"), item("Same?"))
        flow.toggle(0, 0)
        flow.toggle(1, 0)
        assertNull(flow.answers())
    }

    @Test
    fun answers_fit_the_codec() {
        val flow = flow(item("Colour?"), item("Sizes?", options = listOf("S", "M"), multi = true))
        flow.toggle(0, 0)
        flow.toggle(1, 1)
        val line = AgentdProtocolCodec.questionAnswer("claude:s1", flow.alertId, flow.payload.requestRef, flow.answers()!!, "m1")
        val answers = org.json.JSONObject(line).getJSONObject("answers")
        assertEquals("Red", answers.getString("Colour?"))
        assertEquals("M", answers.getJSONArray("Sizes?").getString(0))
    }

    @Test
    fun a_multi_select_never_holds_more_than_the_wire_takes() {
        val labels = (1..32).map { "o$it" }
        val flow = flow(item("Many?", options = labels, multi = true, free = true))
        labels.indices.forEach { flow.toggle(0, it) }
        flow.setFreeText(0, "and one more")
        // 32 picks fill the list; the free text would make a 33rd entry agentd refuses.
        assertEquals(32, (flow.answers()?.get("Many?") as List<*>).size)
        assertNull(flow.freeText(0))
    }

    @Test
    fun a_question_text_agentd_refuses_as_a_key_cannot_be_answered() {
        for (text in listOf("__proto__", "constructor", "prototype")) {
            val flow = flow(item(text))
            flow.toggle(0, 0)
            assertNull(text, flow.answers())
        }
    }
}
