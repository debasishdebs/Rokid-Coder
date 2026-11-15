package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentSession
import com.anezium.rokidbus.plugin.agents.ApprovalDecision
import com.anezium.rokidbus.plugin.agents.PairLineTarget

/** The running service as [CoderRuntime] sees it: every command, with its arguments, in order. */
internal class RecordingCommands : CoderCommands {
    val calls = mutableListOf<String>()

    override fun reconcile() {
        calls += "reconcile"
    }

    override fun openDetail(session: AgentSession) {
        calls += "openDetail(${session.id})"
    }

    override fun closeDetail() {
        calls += "closeDetail"
    }

    override fun decideApproval(requestId: String, decision: ApprovalDecision) {
        calls += "decideApproval($requestId, ${decision.wireValue})"
    }

    override fun sendSessionInput(requestId: String, sessionId: String, text: String) {
        calls += "sendSessionInput($requestId, $sessionId, $text)"
    }

    override fun sendV2(frame: String) {
        calls += "sendV2($frame)"
    }

    override fun requestFolders(requestId: String, path: String?) {
        calls += "requestFolders($requestId, $path)"
    }

    override fun requestThreadStart(requestId: String, provider: AgentProvider, path: String, prompt: String) {
        calls += "requestThreadStart($requestId, ${provider.wireValue}, $path, $prompt)"
    }

    override fun forgetMachine(machineId: String) {
        calls += "forgetMachine($machineId)"
    }

    override fun pairWithLine(target: PairLineTarget) {
        calls += "pairWithLine(${target.host}, ${target.port})"
    }

    override fun pushSettings() {
        calls += "pushSettings"
    }

    override fun testLink(provider: AgentProvider) {
        calls += "testLink(${provider.wireValue})"
    }
}
