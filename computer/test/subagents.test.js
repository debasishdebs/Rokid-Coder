"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionStore } = require("../dist/session-store.js");
const { silentLogger } = require("../dist/logger.js");
const { withDaemon, postHook } = require("./helpers/daemon.js");

const ID = "sub-session-1";

function store() {
  const clock = { now: 1_800_000_000_000 };
  const s = new SessionStore({ machineId: "m", machineName: "n" }, silentLogger, () => clock.now);
  const hook = (event, extra = {}) => s.handleHook({ session_id: ID, cwd: "/work/demo", hook_event_name: event, ...extra });
  hook("SessionStart");
  return { clock, s, hook, subagents: () => s.get(ID).subagents };
}

const pre = (id, tool = "Task") => ({ tool_name: tool, tool_use_id: id, tool_input: { description: "look around" } });

test("a_subagent_runs_from_its_task_call_to_its_post_tool_use", () => {
  const { clock, hook, subagents } = store();
  assert.equal(subagents(), undefined, "absent when none");
  hook("PreToolUse", pre("t1"));
  assert.deepEqual(subagents(), { running: 1, since: clock.now });
  clock.now += 5000;
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1" });
  assert.equal(subagents(), undefined);
});

test("the_agent_tool_name_counts_too_and_other_tools_do_not", () => {
  const { hook, subagents } = store();
  hook("PreToolUse", pre("a1", "Agent"));
  hook("PreToolUse", pre("b1", "Bash"));
  hook("PreToolUse", pre("r1", "Read"));
  assert.equal(subagents().running, 1);
  hook("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "b1" });
  assert.equal(subagents().running, 1, "another tool's end ends nothing");
  hook("PostToolUseFailure", { tool_name: "Agent", tool_use_id: "a1" });
  assert.equal(subagents(), undefined);
});

test("parallel_subagents_count_and_since_is_the_oldest_running", () => {
  const { clock, hook, subagents } = store();
  const first = clock.now;
  hook("PreToolUse", pre("t1"));
  clock.now += 1000;
  hook("PreToolUse", pre("t2"));
  clock.now += 1000;
  hook("PreToolUse", pre("t3"));
  assert.deepEqual(subagents(), { running: 3, since: first });
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1" });
  assert.deepEqual(subagents(), { running: 2, since: first + 1000 });
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t3" });
  assert.deepEqual(subagents(), { running: 1, since: first + 1000 });
});

test("subagent_start_and_stop_pair_without_double_counting_the_task_call", () => {
  const { hook, subagents } = store();
  hook("PreToolUse", pre("t1"));
  hook("PreToolUse", pre("t2"));
  hook("SubagentStart", { agent_id: "ag1" });
  hook("SubagentStart", { agent_id: "ag2" });
  hook("SubagentStart", { agent_id: "ag1" });
  assert.equal(subagents().running, 2, "a start joins a task call; a repeat is nothing");
  hook("SubagentStop", { agent_id: "ag1" });
  assert.equal(subagents().running, 1);
  // The return of the call whose subagent already stopped finds nothing to end.
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1", tool_response: { status: "completed", agentId: "ag1" } });
  assert.equal(subagents().running, 1, "never counted off twice");
  hook("SubagentStop", { agent_id: "unknown" });
  assert.equal(subagents().running, 1, "a stop that names nothing known ends nothing");
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t2", tool_response: { status: "completed", agentId: "ag2" } });
  assert.equal(subagents(), undefined);
  hook("SubagentStop", { agent_id: "ag2" });
  assert.equal(subagents(), undefined);
});

test("parallel_starts_in_the_other_order_never_end_the_wrong_subagent", () => {
  const { hook, subagents } = store();
  hook("PreToolUse", pre("t1"));
  hook("PreToolUse", pre("t2"));
  hook("SubagentStart", { agent_id: "a2" });
  hook("SubagentStart", { agent_id: "a1" });
  hook("SubagentStop", { agent_id: "a2" });
  assert.equal(subagents().running, 1);
  // t2 launched a2, which is over; a1 (t1's) is still running. With or without the result naming its agent.
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t2" });
  assert.equal(subagents().running, 1, "a guessed id is not ended by a result that names none");
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t2", tool_response: { status: "completed", agentId: "a2" } });
  assert.equal(subagents().running, 1, "the result names a2, which already ended");
  hook("SubagentStop", { agent_id: "a1" });
  assert.equal(subagents(), undefined);
});

test("a_start_naming_its_tool_call_binds_exactly", () => {
  const { hook, subagents } = store();
  hook("PreToolUse", pre("t1"));
  hook("PreToolUse", pre("t2"));
  hook("SubagentStart", { agent_id: "a2", tool_use_id: "t2" });
  hook("SubagentStart", { agent_id: "a1", tool_use_id: "t1" });
  hook("SubagentStop", { agent_id: "a2" });
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t2" });
  assert.equal(subagents().running, 1, "t2 was a2's: a1 goes on");
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1" });
  assert.equal(subagents(), undefined, "t1 was a1's, and its call returned");
});

test("a_background_launch_keeps_running_until_its_subagent_stop", () => {
  const { clock, hook, subagents } = store();
  const first = clock.now;
  hook("PreToolUse", { ...pre("t1"), tool_input: { run_in_background: true } });
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1", tool_response: { status: "async_launched", agentId: "bg1" } });
  assert.deepEqual(subagents(), { running: 1, since: first }, "the launch returning is not the end");
  hook("Stop");
  assert.equal(subagents().running, 1, "it outlives the turn that launched it");
  hook("SubagentStop", { agent_id: "bg1" });
  assert.equal(subagents(), undefined);
});

test("a_launch_result_names_the_agent_a_swapped_start_got_wrong", () => {
  const { hook, subagents } = store();
  hook("PreToolUse", pre("t1"));
  hook("PreToolUse", pre("t2"));
  hook("SubagentStart", { agent_id: "a2" });
  hook("SubagentStart", { agent_id: "a1" });
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t2", tool_response: { status: "async_launched", agentId: "a2" } });
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1", tool_response: { status: "async_launched", agentId: "a1" } });
  hook("SubagentStop", { agent_id: "a2" });
  assert.equal(subagents().running, 1);
  hook("SubagentStop", { agent_id: "a1" });
  assert.equal(subagents(), undefined);
});

test("session_end_clears_background_subagents_too", () => {
  const { hook, subagents } = store();
  hook("PreToolUse", pre("t1"));
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1", tool_response: { status: "async_launched", agentId: "bg1" } });
  hook("SessionEnd");
  assert.equal(subagents(), undefined);
});

test("a_subagent_start_with_no_task_call_is_ended_by_its_stop", () => {
  const { hook, subagents } = store();
  hook("SubagentStart", { agent_id: "solo" });
  assert.equal(subagents().running, 1);
  hook("SubagentStop", { agent_id: "solo" });
  assert.equal(subagents(), undefined);
});

test("stop_and_session_end_clear_every_subagent", () => {
  const { hook, subagents } = store();
  hook("PreToolUse", pre("t1"));
  hook("PreToolUse", pre("t2"));
  hook("Stop");
  assert.equal(subagents(), undefined);
  hook("PreToolUse", pre("t3"));
  assert.equal(subagents().running, 1);
  hook("SessionEnd");
  assert.equal(subagents(), undefined);
});

test("the_phone_gets_subagents_in_session_upsert_and_snapshot_only_while_some_run", async () => {
  await withDaemon({ transport: "wshub", tls: true, stopHold: false, attached: [{ provider: "claude", id: ID }] }, async ({ phone, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: ID, cwd: "/work/demo" });
    const idle = await phone.waitFor("session_upsert", (f) => f.session.id === ID);
    assert.equal("subagents" in idle.session, false, "an older phone sees exactly the frame it always saw");
    await postHook(httpPort, { hook_event_name: "PreToolUse", session_id: ID, ...pre("t1") });
    await postHook(httpPort, { hook_event_name: "PreToolUse", session_id: ID, ...pre("t2") });
    const busy = await phone.waitFor("session_upsert", (f) => f.session.id === ID && f.session.subagents?.running === 2);
    assert.deepEqual(Object.keys(busy.session.subagents).sort(), ["running", "since"]);
    assert.equal(typeof busy.session.subagents.since, "number");
    // A parser that reads only the fields it knows is untouched by the new key.
    const known = ({ id, status, heading, mode, capabilities }) => ({ id, status, heading, mode, capabilities });
    assert.deepEqual(known(JSON.parse(JSON.stringify(busy.session))), known(idle.session));
    await postHook(httpPort, { hook_event_name: "Stop", session_id: ID });
    const done = await phone.waitFor("session_upsert", (f) => f.session.id === ID && f.session.status === "idle" && !("subagents" in f.session) && f.seq > busy.seq);
    assert.ok(done);
  });
});
