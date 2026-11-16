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

const start = (id, extra = {}) => ({ agent_id: id, agent_type: "general-purpose", ...extra });

test("a_subagent_runs_from_its_start_to_its_stop", () => {
  const { clock, hook, subagents } = store();
  assert.equal(subagents(), undefined, "absent when none");
  hook("SubagentStart", start("a1"));
  assert.deepEqual(subagents(), { running: 1, since: clock.now });
  clock.now += 5000;
  hook("SubagentStop", { agent_id: "a1" });
  assert.equal(subagents(), undefined);
});

test("the_task_and_agent_tool_calls_count_for_nothing", () => {
  const { hook, subagents } = store();
  for (const tool of ["Task", "Agent"]) {
    hook("PreToolUse", { tool_name: tool, tool_use_id: `t-${tool}`, tool_input: { description: "x" } });
    assert.equal(subagents(), undefined);
    hook("PostToolUse", { tool_name: tool, tool_use_id: `t-${tool}`, tool_response: { status: "async_launched", agentId: "zz" } });
  }
  assert.equal(subagents(), undefined);
});

test("parallel_subagents_count_and_since_is_the_oldest_live_one", () => {
  const { clock, hook, subagents } = store();
  const first = clock.now;
  hook("SubagentStart", start("a1"));
  clock.now += 1000;
  hook("SubagentStart", start("a2"));
  clock.now += 1000;
  hook("SubagentStart", start("a3"));
  assert.deepEqual(subagents(), { running: 3, since: first });
  hook("SubagentStop", { agent_id: "a1" });
  assert.deepEqual(subagents(), { running: 2, since: first + 1000 });
  hook("SubagentStop", { agent_id: "a3" });
  assert.deepEqual(subagents(), { running: 1, since: first + 1000 });
});

test("a_duplicate_start_is_idempotent_an_unknown_stop_is_ignored_and_a_resume_counts_again", () => {
  const { clock, hook, subagents } = store();
  const first = clock.now;
  hook("SubagentStart", start("a1"));
  clock.now += 1000;
  hook("SubagentStart", start("a1"));
  assert.deepEqual(subagents(), { running: 1, since: first });
  hook("SubagentStop", { agent_id: "nobody" });
  hook("SubagentStop", {});
  assert.equal(subagents().running, 1);
  hook("SubagentStop", { agent_id: "a1" });
  assert.equal(subagents(), undefined);
  // Claude resumes a subagent under the same agent id, and SubagentStart fires again.
  hook("SubagentStart", start("a1"));
  assert.equal(subagents().running, 1, "a resumed subagent runs again");
  hook("SubagentStop", { agent_id: "a1" });
  assert.equal(subagents(), undefined);
});

test("a_background_subagent_outlives_the_parents_stop", () => {
  const { hook, subagents } = store();
  hook("UserPromptSubmit", { prompt: "go" });
  hook("SubagentStart", start("bg1"));
  hook("Stop");
  assert.equal(subagents().running, 1);
  hook("SubagentStop", { agent_id: "bg1" });
  assert.equal(subagents(), undefined);
});

test("session_start_and_session_end_clear_every_subagent", () => {
  const { hook, subagents } = store();
  hook("SubagentStart", start("a1"));
  hook("SessionStart");
  assert.equal(subagents(), undefined);
  hook("SubagentStart", start("a2"));
  hook("SessionEnd");
  assert.equal(subagents(), undefined);
});

test("codex_repros_now_via_start_and_stop_only", () => {
  // Pre(t1), Pre(t2), Start(a2), Start(a1), Stop(a1), then the tool results: a2 is still live.
  const first = store();
  first.hook("PreToolUse", { tool_name: "Task", tool_use_id: "t1" });
  first.hook("PreToolUse", { tool_name: "Task", tool_use_id: "t2" });
  first.hook("SubagentStart", start("a2"));
  first.hook("SubagentStart", start("a1"));
  first.hook("SubagentStop", { agent_id: "a1" });
  first.hook("PostToolUse", { tool_name: "Task", tool_use_id: "t2", tool_response: { status: "async_launched", agentId: "a2" } });
  first.hook("PostToolUse", { tool_name: "Task", tool_use_id: "t1", tool_response: { status: "completed" } });
  assert.equal(first.subagents().running, 1, "a2 is live");
  first.hook("SubagentStop", { agent_id: "a2" });
  assert.equal(first.subagents(), undefined);

  // Three parallel agents, a2 stopping early, results arriving in any order, then the parent's Stop.
  const second = store();
  for (const n of [1, 2, 3]) second.hook("PreToolUse", { tool_name: "Task", tool_use_id: `t${n}` });
  for (const n of [2, 3, 1]) second.hook("SubagentStart", start(`a${n}`));
  second.hook("SubagentStop", { agent_id: "a2" });
  for (const [t, a] of [["t2", "a2"], ["t1", "a1"], ["t3", "a3"]]) {
    second.hook("PostToolUse", { tool_name: "Task", tool_use_id: t, tool_response: { status: "async_launched", agentId: a } });
  }
  second.hook("Stop");
  assert.equal(second.subagents().running, 2, "a1 and a3 are live");
  second.hook("SubagentStop", { agent_id: "a1" });
  second.hook("SubagentStop", { agent_id: "a3" });
  assert.equal(second.subagents(), undefined);
});

function* orderings(items, needs, chosen = []) {
  if (chosen.length === items.length) {
    yield chosen;
    return;
  }
  for (const item of items) {
    if (!chosen.includes(item) && (needs[item] ?? []).every((before) => chosen.includes(before))) {
      yield* orderings(items, needs, [...chosen, item]);
    }
  }
}

test("any_order_of_three_agents_starts_and_stops_counts_exactly_the_live_ones", () => {
  const events = ["start1", "start2", "start3", "stop1", "stop2", "stop3"];
  const needs = { stop1: ["start1"], stop2: ["start2"], stop3: ["start3"] };
  let checked = 0;
  for (const order of orderings(events, needs)) {
    const { hook, subagents } = store();
    const live = new Set();
    for (const event of order) {
      const n = event.slice(-1);
      if (event.startsWith("start")) {
        hook("SubagentStart", start(`a${n}`));
        live.add(n);
      } else {
        hook("SubagentStop", { agent_id: `a${n}` });
        live.delete(n);
      }
      assert.equal(subagents()?.running ?? 0, live.size, `${order.join(" ")} at ${event}`);
    }
    assert.equal(subagents(), undefined, order.join(" "));
    checked += 1;
  }
  assert.equal(checked, 90);
});

test("the_phone_gets_subagents_in_session_upsert_and_snapshot_only_while_some_run", async () => {
  await withDaemon({ transport: "wshub", tls: true, stopHold: false, attached: [{ provider: "claude", id: ID }] }, async ({ phone, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: ID, cwd: "/work/demo" });
    const idle = await phone.waitFor("session_upsert", (f) => f.session.id === ID);
    assert.equal("subagents" in idle.session, false, "an older phone sees exactly the frame it always saw");
    await postHook(httpPort, { hook_event_name: "SubagentStart", session_id: ID, agent_id: "a1" });
    await postHook(httpPort, { hook_event_name: "SubagentStart", session_id: ID, agent_id: "a2" });
    const busy = await phone.waitFor("session_upsert", (f) => f.session.id === ID && f.session.subagents?.running === 2);
    assert.deepEqual(Object.keys(busy.session.subagents).sort(), ["running", "since"]);
    assert.equal(typeof busy.session.subagents.since, "number");
    // A parser that reads only the fields it knows is untouched by the new key.
    const known = ({ id, status, heading, mode, capabilities }) => ({ id, status, heading, mode, capabilities });
    assert.deepEqual(known(JSON.parse(JSON.stringify(busy.session))), known(idle.session));
    await postHook(httpPort, { hook_event_name: "SubagentStop", session_id: ID, agent_id: "a1" });
    await postHook(httpPort, { hook_event_name: "SubagentStop", session_id: ID, agent_id: "a2" });
    const done = await phone.waitFor("session_upsert", (f) => f.session.id === ID && !("subagents" in f.session) && f.seq > busy.seq);
    assert.ok(done);
  });
});
