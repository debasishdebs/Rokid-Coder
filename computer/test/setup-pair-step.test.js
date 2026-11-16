"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { pairStep } = require("../dist/setup/pair-step.js");

/** A terminal: what was written, lines the test types, and a watcher it drives by hand. */
function terminal() {
  const out = [];
  const lines = [];
  let waiter;
  const confirmed = [];
  let handler;
  let stopped = 0;
  return {
    out,
    confirmed,
    stopped: () => stopped,
    io: {
      write: (text) => out.push(text),
      readLine: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => (waiter = resolve))),
    },
    type(line) {
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve(line);
      } else {
        lines.push(line);
      }
    },
    watch: (onStatus) => {
      handler = onStatus;
      return { confirm: (attempt, ok) => confirmed.push([attempt, ok]), stop: () => (stopped += 1) };
    },
    status: (status) => handler(status),
    text: () => out.join(""),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a_code_that_appears_at_the_prompt_is_shown_and_asked_there", async () => {
  const t = terminal();
  const done = pairStep(async () => 1, t.io, t.watch);
  await tick();
  assert.match(t.text(), /Not paired yet\. \[R\]etry/);
  t.status({ attempt: "a1", state: "AWAITING_CONFIRM", code: "123456" });
  await tick();
  assert.match(t.text(), /Pairing code: 123 456 \(123456\)\nDoes your phone show this same code\? Confirm on the phone too\. \[y\/N\] /);
  t.type("y");
  await tick();
  assert.deepEqual(t.confirmed, [["a1", true]]);
  assert.match(t.text(), /Now confirm on the phone\./);
  t.status({ attempt: "a1", state: "PINNED" });
  assert.equal(await done, "paired");
  assert.equal(t.stopped(), 1, "the watcher is released");
});

test("an_n_declines_the_code_and_the_abort_brings_the_menu_back", async () => {
  const t = terminal();
  const done = pairStep(async () => 1, t.io, t.watch);
  await tick();
  t.status({ attempt: "a1", state: "AWAITING_CONFIRM", code: "654321" });
  await tick();
  t.type("n");
  await tick();
  assert.deepEqual(t.confirmed, [["a1", false]]);
  t.status({ attempt: "a1", state: "ABORTED", reason: "mismatch" });
  await tick();
  assert.match(t.text(), /The codes did not match, so nothing was paired\.\nNot paired yet\./);
  t.type("l");
  assert.equal(await done, "later");
});

test("a_second_peer_abort_is_explained_and_a_new_code_is_asked_again", async () => {
  const t = terminal();
  const done = pairStep(async () => 1, t.io, t.watch);
  await tick();
  t.status({ attempt: "a1", state: "AWAITING_CONFIRM", code: "111111" });
  await tick();
  t.status({ attempt: "a1", state: "ABORTED", reason: "second_peer" });
  await tick();
  assert.match(t.text(), /More than one device answered — try again\./);
  t.status({ attempt: "a2", state: "AWAITING_CONFIRM", code: "222222" });
  await tick();
  assert.match(t.text(), /Pairing code: 222 222/);
  t.type("y");
  await tick();
  assert.deepEqual(t.confirmed, [["a2", true]]);
  t.status({ attempt: "a2", state: "PINNED" });
  assert.equal(await done, "paired");
});

test("the_end_of_an_attempt_that_was_never_seen_running_is_not_announced", async () => {
  const t = terminal();
  const done = pairStep(async () => 1, t.io, t.watch);
  await tick();
  // What agentd replays on joining: the last attempt, long over.
  t.status({ attempt: "old", state: "ABORTED", reason: "timeout" });
  await tick();
  assert.equal(t.text().includes("timed out"), false);
  t.type("L");
  assert.equal(await done, "later");
});

test("typing_still_chooses_retry_and_later_and_end_of_input_leaves", async () => {
  const t = terminal();
  let runs = 0;
  const done = pairStep(async () => (runs += 1, runs === 2 ? 0 : 1), t.io, t.watch);
  await tick();
  t.type("r");
  assert.equal(await done, "paired");
  assert.equal(runs, 2);

  const eof = terminal();
  const left = pairStep(async () => 1, eof.io, eof.watch);
  await tick();
  eof.type(undefined);
  assert.equal(await left, "later");
});

test("without_a_watcher_the_prompt_behaves_as_before", async () => {
  const t = terminal();
  const done = pairStep(async () => 1, t.io);
  await tick();
  t.type("t");
  await tick();
  assert.match(t.text(), /tailscale\.com\/download/);
  t.type("l");
  assert.equal(await done, "later");
});
