"use strict";
/**
 * Records the alert frames agentd's real AlertQueue (dist/alerts.js) sends in
 * the phone scenarios, and writes them to contracts/alert-sequences.json. The
 * Agents plugin's AlertCoordinatorTest replays that file: it feeds the
 * `agentd` frames and the `glasses` events to the coordinator and checks that
 * what the coordinator writes is exactly the recorded `phone` frames, in order.
 *
 * The phone's frames are fed back to the queue the way phone-v2.ts does it:
 * `alert_shown` acks, `alert_dismissed` parks an approval or question and
 * closes anything else, `alert_action` settles the alert. An `alert_closed` is
 * recorded for every close but a dismiss, as phone-v2.ts sends it. A frame sent
 * while the link is down is refused and never recorded. A `lost` phone frame
 * is recorded but never reaches the queue.
 *
 * Ids are the names the scenario gives its alerts, not the queue's UUIDs, so
 * the file is the same on every run. alert-sequences.test.js fails when the
 * committed file is stale. Regenerate it with: npm run build && node test/record-alert-sequences.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { AlertQueue } = require("../dist/alerts.js");

const OUT = path.join(__dirname, "..", "..", "contracts", "alert-sequences.json");
const START = 1_000_000;

/** The defaults agentd and the phone share (phone-settings.ts). */
const DEFAULT_TIMINGS = {
  ageBoostMs: 30_000,
  dwellMs: 8_000,
  ackTimeoutMs: 5_000,
  retryBackoffMs: [5_000, 10_000, 20_000],
  reminderMs: 300_000,
  expireMs: 1_800_000,
};

function recorder(timings) {
  let t = START;
  let linked = true;
  let pushing;
  const steps = [];
  const names = new Map();
  const ids = new Map();
  const kinds = new Map();
  const at = () => t - START;

  const nameOf = (id) => {
    if (!names.has(id)) {
      // Only the alert being pushed can be unknown: its first frame goes out inside push().
      names.set(id, pushing);
    }
    return names.get(id);
  };
  const deliver = (frame) => {
    if (!linked) {
      return false;
    }
    steps.push({ t: at(), agentd: { ...frame, id: nameOf(frame.id) } });
    return true;
  };
  const queue = new AlertQueue(timings, deliver, () => t, (alert, reason) => {
    if (reason !== "dismissed") {
      deliver({ type: "alert_closed", v: 2, id: alert.id, reason });
    }
  });

  const s = {
    push(name, kind, fields = {}) {
      steps.push({ t: at(), op: "push", id: name, kind });
      pushing = name;
      const id = queue.push({
        sessionKey: "claude:s1",
        kind,
        title: `${kind} ${name}`,
        body: `${kind} body ${name}`,
        ...(kind === "approval" ? { actions: ["allow", "deny"] } : {}),
        ...(kind === "question" ? { question: { requestRef: `ref-${name}`, source: "claude_tool", items: [{ text: `Pick ${name}?`, options: [{ label: "yes" }], multiSelect: false, allowFreeText: true }] } } : {}),
        createdAt: t,
        ...fields,
      });
      pushing = undefined;
      names.set(id, name);
      ids.set(name, id);
      kinds.set(name, kind);
      return s;
    },
    withdraw(name) {
      steps.push({ t: at(), op: "withdraw", id: name });
      queue.withdraw(ids.get(name));
      return s;
    },
    advance(ms) {
      t += ms;
      queue.tick();
      return s;
    },
    glasses(event, name, extra = {}) {
      steps.push({ t: at(), glasses: { event, id: name, ...extra } });
      return s;
    },
    phone(type, name, extra = {}, { lost = false } = {}) {
      const frame = { type, v: 2, id: name, ...extra };
      steps.push({ t: at(), phone: frame, ...(lost ? { lost: true } : {}) });
      if (lost) {
        return s;
      }
      const id = ids.get(name);
      if (type === "alert_shown") {
        queue.onShown(id);
      } else if (type === "alert_dismissed") {
        const kind = kinds.get(name);
        if (kind === "approval" || kind === "question") {
          queue.park(id);
        } else {
          queue.onDismissed(id);
        }
      } else if (type === "alert_action") {
        queue.onActed(id);
      }
      return s;
    },
    /** The phone's alert_action; its msgId is the phone's own, so the file only says one is there. */
    act(name, action) {
      return s.phone("alert_action", name, { action, msgId: "*" });
    },
    linkDown() {
      steps.push({ t: at(), link: "down" });
      linked = false;
      return s;
    },
    linkUp() {
      steps.push({ t: at(), link: "up" });
      linked = true;
      queue.linkUp();
      return s;
    },
    done(description) {
      return { description, timings, steps };
    },
  };
  return s;
}

const SCENARIOS = {
  burst: () => recorder(DEFAULT_TIMINGS)
    .push("A", "question")
    .glasses("shown", "A").phone("alert_shown", "A")
    .advance(1_000).push("B", "error").push("C", "done")
    .advance(1_000).push("D", "approval")
    .glasses("shown", "D").phone("alert_shown", "D")
    .advance(1_000).glasses("action", "D", { action: "allow" }).act("D", "allow")
    .glasses("shown", "A").phone("alert_shown", "A")
    .advance(8_000)
    .advance(5_000)
    .glasses("shown", "B").phone("alert_shown", "B")
    .advance(8_000)
    .glasses("shown", "C").phone("alert_shown", "C")
    .done("A question on the glasses, then an error, a done and an approval: the approval preempts, the rest take turns"),

  reminder: () => recorder({ ...DEFAULT_TIMINGS, reminderMs: 30_000 })
    .push("A", "approval")
    .glasses("shown", "A").phone("alert_shown", "A")
    .advance(20_000).glasses("closed", "A", { reason: "TIMEOUT" })
    .advance(10_000)
    .glasses("shown", "A").phone("alert_shown", "A")
    .advance(30_000)
    .glasses("shown", "A").phone("alert_shown", "A")
    .done("An acknowledged approval nobody acts on: a reminder after its band timed out, and one while its band is still up"),

  lost_ack: () => recorder(DEFAULT_TIMINGS)
    .push("A", "notice")
    .glasses("shown", "A").phone("alert_shown", "A", {}, { lost: true })
    .advance(5_000).phone("alert_shown", "A", {}, { lost: true })
    .advance(10_000).phone("alert_shown", "A")
    .advance(20_000)
    .done("The glasses showed the alert but the alert_shown acks are lost: each retry carries a fresh ack until one lands"),

  preemption: () => recorder(DEFAULT_TIMINGS)
    .push("A", "notice")
    .glasses("shown", "A").phone("alert_shown", "A")
    .advance(2_000).push("B", "approval")
    .glasses("shown", "B").phone("alert_shown", "B")
    .advance(1_000).glasses("action", "B", { action: "allow" }).act("B", "allow")
    .glasses("shown", "A").phone("alert_shown", "A")
    .done("An approval displaces a notice inside its dwell; once answered, the notice resumes"),

  park_reminder: () => recorder(DEFAULT_TIMINGS)
    .push("A", "approval")
    .advance(2_000).glasses("closed", "A", { reason: "USER" })
    .phone("alert_shown", "A").phone("alert_dismissed", "A")
    .advance(298_000)
    .glasses("shown", "A").phone("alert_shown", "A")
    .advance(1_000).glasses("action", "A", { action: "allow" }).act("A", "allow")
    .done("The wearer dismisses an approval: agentd parks it and it comes back as a reminder, under the same id"),

  link_up: () => recorder(DEFAULT_TIMINGS)
    .push("A", "error")
    .advance(1_000).linkDown()
    .advance(1_000).push("B", "question").push("C", "notice").withdraw("C")
    .advance(4_000)
    .advance(4_000).linkUp()
    .glasses("shown", "B").phone("alert_shown", "B")
    .advance(1_000).glasses("closed", "B", { reason: "USER" })
    .phone("alert_dismissed", "B")
    .glasses("shown", "A").phone("alert_shown", "A")
    .done("The link drops before the error is acked; a question waits and a notice comes and goes meanwhile. At link up the question goes first and the error resumes after it"),
};

function record() {
  const scenarios = {};
  for (const [name, run] of Object.entries(SCENARIOS)) {
    scenarios[name] = run();
  }
  return {
    _comment: "Generated by agentd/test/record-alert-sequences.js from the real AlertQueue. Do not edit by hand.",
    scenarios,
  };
}

function serialize(sequences) {
  return `${JSON.stringify(sequences, null, 2)}\n`;
}

module.exports = { OUT, record, serialize };

if (require.main === module) {
  fs.writeFileSync(OUT, serialize(record()));
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
