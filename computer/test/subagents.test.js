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
  assert.equal(subagents().running, 2, "a start binds to its task call; a repeat is nothing");
  hook("SubagentStop", { agent_id: "ag1" });
  assert.equal(subagents().running, 1);
  // The Post of the one SubagentStop already ended finds nothing.
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1" });
  assert.equal(subagents().running, 1, "never counted off twice");
  hook("SubagentStop", { agent_id: "unknown" });
  assert.equal(subagents().running, 1, "a stop that names nothing known ends nothing");
  hook("PostToolUse", { tool_name: "Task", tool_use_id: "t2" });
  assert.equal(subagents(), undefined);
  hook("SubagentStop", { agent_id: "ag2" });
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
