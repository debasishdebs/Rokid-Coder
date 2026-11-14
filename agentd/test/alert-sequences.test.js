"use strict";
/**
 * contracts/alert-sequences.json is what the Agents plugin's AlertCoordinatorTest
 * replays as agentd's behaviour. Recording it again from the real AlertQueue
 * must give the committed file, byte for byte: a queue change that alters a
 * scenario fails here until the file is regenerated and the phone side re-run.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { OUT, record, serialize } = require("./record-alert-sequences.js");

test("committed_alert_sequences_match_the_real_queue", () => {
  const committed = fs.readFileSync(OUT, "utf8");
  const fresh = serialize(record());
  assert.deepEqual(JSON.parse(committed), JSON.parse(fresh), "stale: run `node test/record-alert-sequences.js` in agentd");
  assert.equal(committed, fresh);
});

test("every_scenario_the_phone_replays_is_recorded", () => {
  const { scenarios } = record();
  assert.deepEqual(Object.keys(scenarios), ["burst", "reminder", "lost_ack", "preemption", "park_reminder", "link_up", "empty_slot_link_up"]);
  for (const [name, scenario] of Object.entries(scenarios)) {
    assert.ok(scenario.steps.some((step) => step.agentd), `${name} records no agentd frame`);
  }
});
