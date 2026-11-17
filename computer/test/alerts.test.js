const test = require("node:test");
const assert = require("node:assert/strict");
const { AlertQueue, MAX_BAND_DWELL_MS } = require("../dist/alerts.js");

const TIMINGS = {
  ageBoostMs: 30_000,
  dwellMs: 8_000,
  ackTimeoutMs: 5_000,
  retryBackoffMs: [5_000, 10_000, 20_000],
  reminderMs: 300_000,
  expireMs: 1_800_000,
};

function setup(timings = TIMINGS) {
  let t = 1_000_000;
  const frames = [];
  const queue = new AlertQueue(timings, (frame) => {
    frames.push(frame);
    return true;
  }, () => t);
  return {
    queue,
    frames,
    now: () => t,
    advance(ms) {
      t += ms;
      queue.tick();
    },
  };
}

function alert(kind, extra = {}) {
  return { sessionKey: "claude:s1", kind, title: `${kind} title`, body: `${kind} body`, createdAt: 1_000_000, ...extra };
}

/** Pushes an approval that holds the glasses until the test acts on it. */
function hold(env) {
  const id = env.queue.push(alert("approval", { createdAt: env.now() }));
  env.queue.onShown(id);
  return id;
}

/** Acks and acts on whatever is current, returning its kind. */
function drain(env) {
  const kinds = [];
  for (let current = env.queue.current(); current; current = env.queue.current()) {
    kinds.push(current.kind);
    env.queue.onShown(current.id);
    env.queue.onActed(current.id);
  }
  return kinds;
}

test("orders_by_priority_then_age", () => {
  const env = setup();
  const blocker = hold(env);
  const at = (offset) => env.now() + offset;
  env.queue.push(alert("done", { createdAt: at(0) }));
  env.queue.push(alert("notice", { createdAt: at(1) }));
  env.queue.push(alert("error", { createdAt: at(2), title: "old error" }));
  env.queue.push(alert("question", { createdAt: at(3) }));
  env.queue.push(alert("error", { createdAt: at(4), title: "new error" }));
  env.queue.push(alert("approval", { createdAt: at(5), title: "second approval" }));

  env.queue.onActed(blocker);
  const sent = [];
  for (let current = env.queue.current(); current; current = env.queue.current()) {
    sent.push(`${current.kind}:${current.title}`);
    env.queue.onShown(current.id);
    env.queue.onActed(current.id);
  }
  assert.deepEqual(sent, [
    "approval:second approval",
    "question:question title",
    "error:old error",
    "error:new error",
    "notice:notice title",
    "done:done title",
  ]);
});

test("age_boost_promotes_after_30s", () => {
  const env = setup();
  const blocker = hold(env);
  env.queue.push(alert("done", { createdAt: env.now() - 31_000, title: "stale done" }));
  env.queue.push(alert("error", { createdAt: env.now(), title: "fresh error" }));
  env.queue.onActed(blocker);
  assert.equal(env.queue.current().title, "stale done");
  assert.equal(env.queue.current().promoted, true);

  const fresh = setup();
  const holder = hold(fresh);
  fresh.queue.push(alert("done", { createdAt: fresh.now() - 29_000, title: "young done" }));
  fresh.queue.push(alert("error", { createdAt: fresh.now(), title: "fresh error" }));
  fresh.queue.onActed(holder);
  assert.equal(fresh.queue.current().title, "fresh error");
  assert.equal(fresh.queue.current().promoted, false);
});

test("age_boost_does_not_preempt_a_shown_alert", () => {
  const env = setup();
  const id = env.queue.push(alert("done", { createdAt: env.now(), title: "shown done" }));
  env.queue.onShown(id);
  env.queue.push(alert("error", { createdAt: env.now() - 31_000 }));
  env.advance(1_000);
  assert.equal(env.queue.current().title, "shown done");
});

test("dwell_holds_shown_alert_8s", () => {
  const env = setup();
  const first = env.queue.push(alert("done", { title: "first" }));
  env.queue.onShown(first);
  env.queue.push(alert("error", { title: "second" }));

  // The push is told to the phone as a waiting-count update of "first", nothing more.
  const fresh = () => env.frames.filter((f) => f.reason !== "update");
  env.advance(7_999);
  assert.equal(env.queue.current().title, "first");
  assert.equal(fresh().length, 1);

  env.advance(1);
  assert.equal(env.queue.current().title, "second");
  assert.equal(fresh().length, 2);
  assert.equal(fresh()[1].title, "second");
});

test("acting_on_the_shown_alert_releases_the_glasses_inside_the_dwell", () => {
  const env = setup();
  const first = env.queue.push(alert("done", { title: "first" }));
  env.queue.onShown(first);
  env.queue.push(alert("error", { title: "second" }));
  env.advance(1_000);
  env.queue.onActed(first);
  assert.equal(env.queue.current().title, "second");
});

test("preempts_done_with_approval_and_requeues", () => {
  const env = setup();
  const done = env.queue.push(alert("done", { createdAt: env.now(), title: "done" }));
  env.queue.onShown(done);
  env.queue.push(alert("done", { createdAt: env.now() - 5_000, title: "older done" }));
  env.advance(3_000);

  const approval = env.queue.push(alert("approval", { createdAt: env.now(), title: "approval" }));
  assert.equal(env.queue.current().id, approval);
  assert.equal(env.frames.at(-1).kind, "approval");
  assert.equal(env.queue.waitingCount(), 2);

  // The displaced alert returns at the head of its class, ahead of the older one.
  env.queue.onShown(approval);
  env.queue.onActed(approval);
  assert.equal(env.queue.current().id, done);
  assert.equal(env.queue.current().state, "sent");
  assert.equal(env.frames.at(-1).id, done);
});

test("preempt_also_displaces_an_alert_still_waiting_for_its_ack", () => {
  const env = setup();
  env.queue.push(alert("done", { title: "unacked" }));
  env.queue.push(alert("approval", { title: "approval" }));
  assert.equal(env.queue.current().title, "approval");
});

test("only_a_new_approval_preempts_and_never_another_approval", () => {
  const env = setup();
  const first = env.queue.push(alert("approval", { createdAt: env.now(), title: "first" }));
  env.queue.onShown(first);
  env.queue.push(alert("approval", { createdAt: env.now(), title: "second" }));
  const error = setup();
  const shown = error.queue.push(alert("done", { title: "done" }));
  error.queue.onShown(shown);
  error.queue.push(alert("error", { title: "error" }));
  error.queue.push(alert("question", { title: "question" }));
  env.advance(1_000);
  error.advance(1_000);
  assert.equal(env.queue.current().title, "first");
  assert.equal(error.queue.current().title, "done");
});

test("retries_until_shown_with_backoff", () => {
  const env = setup();
  const id = env.queue.push(alert("question"));
  assert.equal(env.frames.length, 1);

  env.advance(4_999);
  assert.equal(env.frames.length, 1);
  env.advance(1); // +5 s
  assert.equal(env.frames.length, 2);

  env.advance(9_999);
  assert.equal(env.frames.length, 2);
  env.advance(1); // +10 s
  assert.equal(env.frames.length, 3);

  env.advance(19_999);
  assert.equal(env.frames.length, 3);
  env.advance(1); // +20 s
  assert.equal(env.frames.length, 4);

  env.advance(20_000); // the last backoff value is kept
  assert.equal(env.frames.length, 5);
  assert.equal(env.queue.current().attempts, 5);
  assert.deepEqual(new Set(env.frames.map((f) => f.id)), new Set([id]));

  env.queue.onShown(id);
  assert.equal(env.queue.current().state, "shown");
  env.advance(60_000);
  assert.equal(env.frames.length, 5);
});

test("a_refused_or_throwing_sink_still_follows_the_retry_schedule", () => {
  let t = 0;
  let calls = 0;
  const queue = new AlertQueue(TIMINGS, () => {
    calls += 1;
    if (calls === 2) {
      throw new Error("link down");
    }
    return false;
  }, () => t);
  queue.push({ ...alert("error"), createdAt: 0 });
  t += 5_000;
  queue.tick();
  t += 10_000;
  queue.tick();
  assert.equal(calls, 3);
  assert.equal(queue.current().state, "sent");
});

test("reminds_every_X_until_Y_then_expires", () => {
  const env = setup();
  const id = env.queue.push(alert("error", { createdAt: env.now() }));
  env.queue.onShown(id);
  assert.equal(env.frames.length, 1);

  const X = TIMINGS.reminderMs;
  for (let n = 1; n <= 5; n += 1) {
    env.advance(X - 1);
    assert.equal(env.frames.length, n);
    env.advance(1);
    assert.equal(env.frames.length, n + 1);
    assert.equal(env.frames.at(-1).id, id);
    env.queue.onShown(id);
  }
  // 5 reminders at 5-minute spacing; the next would land exactly on Y = 30 min.
  env.advance(X);
  assert.equal(env.frames.length, 6);
  assert.equal(env.queue.current(), undefined);
  assert.equal(env.queue.waitingCount(), 0);
  env.advance(X);
  assert.equal(env.frames.length, 6);
});

test("an_alert_that_is_never_shown_expires_instead_of_retrying_forever", () => {
  const env = setup();
  env.queue.push(alert("done", { createdAt: env.now() }));
  env.advance(TIMINGS.expireMs);
  assert.equal(env.queue.current(), undefined);
  const sent = env.frames.length;
  env.advance(60_000);
  assert.equal(env.frames.length, sent);
});

test("waiting_count_in_every_frame", () => {
  const env = setup();
  const first = env.queue.push(alert("approval", { createdAt: env.now(), title: "a" }));
  assert.equal(env.frames[0].waiting, 0);
  env.queue.onShown(first);
  env.queue.push(alert("error", { createdAt: env.now(), title: "b" }));
  env.queue.push(alert("done", { createdAt: env.now(), title: "c" }));
  assert.equal(env.queue.waitingCount(), 2);
  assert.deepEqual(env.frames.slice(1).map((f) => [f.title, f.reason, f.waiting]), [
    ["a", "update", 1],
    ["a", "update", 2],
  ]);

  env.queue.onActed(first);
  env.queue.onShown(env.frames[3].id);
  assert.equal(env.frames[3].title, "b");
  assert.equal(env.frames[3].waiting, 1);
  env.queue.onActed(env.frames[3].id);
  assert.equal(env.frames[4].title, "c");
  assert.equal(env.frames[4].waiting, 0);
  for (const frame of env.frames) {
    assert.equal(typeof frame.waiting, "number");
  }
});

test("frames_carry_the_v2_alert_shape_with_actions_and_question", () => {
  const env = setup();
  const question = {
    requestRef: "req-1",
    source: "claude_tool",
    items: [{ text: "Which?", options: [{ label: "A" }], multiSelect: false, allowFreeText: true }],
  };
  const id = env.queue.push(alert("question", { actions: ["answer"], question }));
  assert.deepEqual(env.frames[0], {
    type: "alert",
    v: 2,
    id,
    sessionKey: "claude:s1",
    kind: "question",
    title: "question title",
    body: "question body",
    actions: ["answer"],
    question,
    waiting: 0,
    reason: "new",
  });
  env.queue.push(alert("done"));
  const plain = env.queue.current();
  assert.equal(plain.id, id);
  env.queue.onActed(id);
  // frames[1] is the waiting-count update of the question; frames[2] is the done alert.
  assert.equal(env.frames[2].kind, "done");
  assert.equal("actions" in env.frames[2], false);
  assert.equal("question" in env.frames[2], false);
});

test("expire_session_drops_its_alerts_only", () => {
  const env = setup();
  const s1a = env.queue.push(alert("approval", { createdAt: env.now(), title: "s1 current" }));
  env.queue.onShown(s1a);
  env.queue.push(alert("error", { createdAt: env.now(), title: "s1 queued" }));
  env.queue.push(alert("done", { createdAt: env.now(), sessionKey: "codex:t1", title: "t1 queued" }));

  env.queue.expireSession("claude:s1", "session_ended");

  assert.equal(env.queue.current().title, "t1 queued");
  assert.equal(env.queue.waitingCount(), 0);
  env.queue.onShown(s1a); // a late ack for the dropped alert is ignored
  assert.equal(env.queue.current().state, "sent");
  assert.deepEqual(drain(env), ["done"]);
});

test("stale_acks_and_unknown_ids_are_ignored", () => {
  const env = setup();
  const first = hold(env);
  const queued = env.queue.push(alert("done"));
  env.queue.onShown(queued); // still queued: never sent, so nothing to acknowledge
  env.queue.onActed("nope");
  env.queue.onDismissed("nope");
  env.queue.onActed(first);
  assert.equal(env.queue.current().id, queued);
  assert.equal(env.queue.current().state, "sent");
});

test("dismissed_alert_is_dropped_and_the_next_is_sent", () => {
  const env = setup();
  const first = env.queue.push(alert("error", { title: "first" }));
  env.queue.push(alert("done", { title: "second" }));
  env.queue.onDismissed(first);
  assert.equal(env.queue.current().title, "second");
  assert.equal(env.queue.waitingCount(), 0);
});

test("a_link_that_is_down_does_not_escalate_the_backoff_and_linkUp_sends_at_once", () => {
  let t = 0;
  let up = false;
  const sent = [];
  const queue = new AlertQueue(TIMINGS, (frame) => {
    sent.push({ at: t, id: frame.id });
    return up;
  }, () => t);
  const id = queue.push({ ...alert("approval"), createdAt: 0 });
  // Five refusals at the ack timeout: none counted, so the gap never reaches 20 s.
  for (let n = 0; n < 5; n += 1) {
    t += 5_000;
    queue.tick();
  }
  assert.equal(sent.length, 6);
  assert.equal(queue.current().attempts, 0);

  up = true;
  t += 1_000;
  queue.linkUp();
  assert.equal(sent.length, 7);
  assert.equal(sent.at(-1).id, id);
  assert.equal(queue.current().attempts, 1);
});

test("onClose_reports_every_way_out_with_its_reason", () => {
  let t = 0;
  const closed = [];
  const queue = new AlertQueue(TIMINGS, () => true, () => t, (a, reason) => closed.push([a.id, reason]));
  const acted = queue.push({ ...alert("approval"), createdAt: 0 });
  const dismissed = queue.push({ ...alert("done"), createdAt: 1 });
  const withdrawn = queue.push({ ...alert("error"), createdAt: 2 });
  const expiring = queue.push({ ...alert("notice"), createdAt: 3 });
  const ended = queue.push({ ...alert("done", { sessionKey: "claude:other" }), createdAt: 4 });

  queue.onShown(acted);
  queue.onActed(acted);
  queue.onDismissed(dismissed);
  queue.withdraw(withdrawn);
  queue.expireSession("claude:other", "session_ended");
  t += TIMINGS.expireMs + 10;
  queue.tick();
  assert.deepEqual(closed, [
    [acted, "acted"],
    [dismissed, "dismissed"],
    [withdrawn, "withdrawn"],
    [ended, "withdrawn"],
    [expiring, "expired"],
  ]);
  assert.equal(queue.get(expiring), undefined);
});

test("setTimings_applies_to_alerts_already_queued", () => {
  const env = setup();
  const id = hold(env);
  env.queue.setTimings({ ...TIMINGS, expireMs: 10_000 });
  env.advance(10_000);
  assert.equal(env.queue.get(id), undefined);
});

test("first_dispatch_reason_new", () => {
  const env = setup();
  env.queue.push(alert("error", { createdAt: env.now() }));
  assert.equal(env.frames.length, 1);
  assert.equal(env.frames[0].reason, "new");
});

test("retry_reason_retry", () => {
  const env = setup();
  env.queue.push(alert("question", { createdAt: env.now() }));
  env.advance(5_000);
  env.advance(10_000);
  assert.deepEqual(env.frames.map((f) => f.reason), ["new", "retry", "retry"]);
});

test("reminder_after_dwell_reason_reminder", () => {
  const env = setup();
  const id = env.queue.push(alert("error", { createdAt: env.now() }));
  env.queue.onShown(id);
  env.advance(TIMINGS.reminderMs);
  assert.deepEqual(env.frames.map((f) => f.reason), ["new", "reminder"]);
  // A retry of the reminder is a retry, and the next reminder is a reminder again.
  env.advance(5_000);
  env.queue.onShown(id);
  env.advance(TIMINGS.reminderMs);
  assert.deepEqual(env.frames.map((f) => f.reason), ["new", "reminder", "retry", "reminder"]);
});

test("parked_alert_comes_back_reason_reminder", () => {
  const env = setup();
  const id = env.queue.push(alert("approval", { createdAt: env.now() }));
  env.queue.onShown(id);
  env.queue.park(id);
  assert.equal(env.queue.current(), undefined);
  env.advance(TIMINGS.reminderMs);
  assert.equal(env.queue.current().id, id);
  assert.deepEqual(env.frames.map((f) => f.reason), ["new", "reminder"]);
});

test("preempted_alert_resumes_reason_resume", () => {
  const env = setup();
  const done = env.queue.push(alert("done", { createdAt: env.now(), title: "done" }));
  env.queue.onShown(done);
  env.advance(1_000);
  const approval = env.queue.push(alert("approval", { createdAt: env.now(), title: "approval" }));
  assert.equal(env.queue.current().id, approval);
  env.queue.onShown(approval);
  env.queue.onActed(approval);
  assert.equal(env.queue.current().id, done);
  assert.deepEqual(
    env.frames.filter((f) => f.type === "alert" && f.reason !== "update").map((f) => [f.title, f.reason]),
    [["done", "new"], ["approval", "new"], ["done", "resume"]],
  );
});

test("link_up_requeue_reason_resume", () => {
  const env = setup();
  const id = env.queue.push(alert("error", { createdAt: env.now() }));
  env.queue.onShown(id);
  env.advance(1_000);
  env.queue.linkUp();
  assert.equal(env.frames.length, 2);
  assert.equal(env.frames[1].id, id);
  assert.equal(env.frames[1].reason, "resume");
});

test("waiting_change_resends_current_with_update_and_keeps_state", () => {
  // A push, a withdraw and a close of waiting alerts each re-send the occupant.
  const env = setup();
  const current = env.queue.push(alert("approval", { createdAt: env.now() }));
  env.queue.onShown(current);
  env.advance(1_000);
  assert.equal(env.frames.length, 1);

  const second = env.queue.push(alert("done", { createdAt: env.now() }));
  const third = env.queue.push(alert("done", { createdAt: env.now() }));
  assert.deepEqual(
    env.frames.slice(1).map((f) => [f.id, f.reason, f.waiting]),
    [[current, "update", 1], [current, "update", 2]],
  );
  env.queue.withdraw(second);
  assert.deepEqual([env.frames[3].id, env.frames[3].reason, env.frames[3].waiting], [current, "update", 1]);
  env.queue.onDismissed(third);
  assert.deepEqual([env.frames[4].id, env.frames[4].reason, env.frames[4].waiting], [current, "update", 0]);
  assert.equal(env.frames.length, 5);
  assert.equal(env.queue.current().state, "shown");

  // Updates leave attempts, state and the retry clock alone.
  const kept = setup();
  const held = kept.queue.push(alert("question", { createdAt: kept.now() }));
  kept.advance(3_000);
  kept.queue.push(alert("done", { createdAt: kept.now() }));
  assert.equal(kept.frames.at(-1).reason, "update");
  assert.deepEqual([kept.queue.current().state, kept.queue.current().attempts], ["sent", 1]);
  kept.advance(1_999);
  assert.equal(kept.frames.length, 2);
  kept.advance(1); // 5 s after the first send, not after the update
  assert.equal(kept.frames.at(-1).reason, "retry");
  assert.equal(kept.queue.current().attempts, 2);
  assert.equal(kept.queue.current().id, held);
});

/** A queue whose sink takes frames only while `linked` is true. */
function linkable() {
  let t = 1_000_000;
  let linked = false;
  const frames = [];
  const queue = new AlertQueue(TIMINGS, (frame) => {
    if (linked) {
      frames.push(frame);
    }
    return linked;
  }, () => t);
  return {
    queue,
    frames,
    now: () => t,
    link(up) {
      linked = up;
    },
    advance(ms) {
      t += ms;
      queue.tick();
    },
  };
}

test("undelivered_alert_arrives_as_new_after_link_up", () => {
  // Pushed with no phone linked: it takes the empty slot, but nothing reached a link.
  const env = linkable();
  const id = env.queue.push(alert("approval", { createdAt: env.now() }));
  env.advance(6_000);
  assert.equal(env.queue.current().id, id);
  env.link(true);
  env.queue.linkUp();
  assert.deepEqual(env.frames.map((f) => [f.id, f.reason]), [[id, "new"]]);
  // Once delivered, the reasons follow the delivery as before.
  env.advance(5_000);
  env.queue.linkUp();
  assert.deepEqual(env.frames.slice(1).map((f) => f.reason), ["retry", "resume"]);
});

test("undelivered_retry_still_new", () => {
  // The first send was refused; the retry is the first frame the phone hears.
  const env = linkable();
  const id = env.queue.push(alert("notice", { createdAt: env.now() }));
  env.link(true);
  env.advance(5_000);
  assert.deepEqual(env.frames.map((f) => [f.id, f.reason]), [[id, "new"]]);
  env.advance(10_000);
  assert.deepEqual(env.frames.map((f) => f.reason), ["new", "retry"]);
});

// Alert card lifetime: "Alert stays on screen" (dwellMs) and "Remind me again after" (reminderMs).

const frameReasons = (env) => env.frames.filter((f) => f.reason !== "update").map((f) => f.reason);

for (const dwellMs of [8_000, 60_000]) {
  test(`approval_leaves_after_${dwellMs}ms_returns_at_reminderMs_and_answering_stops_reminders`, () => {
    const env = setup({ ...TIMINGS, dwellMs });
    const id = env.queue.push(alert("approval", { createdAt: env.now() }));
    env.queue.onShown(id);

    // Still pending after its card has left the glasses, and still answerable.
    env.advance(dwellMs);
    assert.equal(env.queue.get(id).state, "shown");
    assert.deepEqual(frameReasons(env), ["new"]);

    env.advance(TIMINGS.reminderMs - dwellMs - 1);
    assert.deepEqual(frameReasons(env), ["new"]);
    env.advance(1);
    assert.deepEqual(frameReasons(env), ["new", "reminder"]);

    // The reminder is counted from when its card was shown.
    env.queue.onShown(id);
    env.advance(TIMINGS.reminderMs - 1);
    assert.deepEqual(frameReasons(env), ["new", "reminder"]);
    env.advance(1);
    assert.deepEqual(frameReasons(env), ["new", "reminder", "reminder"]);

    env.queue.onShown(id);
    env.queue.onActed(id);
    env.advance(TIMINGS.reminderMs * 3);
    assert.deepEqual(frameReasons(env), ["new", "reminder", "reminder"]);
    assert.equal(env.queue.get(id), undefined);
  });

  test(`done_leaves_after_${dwellMs}ms_and_never_reminds`, () => {
    const closed = [];
    let t = 1_000_000;
    const frames = [];
    const queue = new AlertQueue({ ...TIMINGS, dwellMs }, (f) => { frames.push(f); return true; }, () => t, (a, reason) => closed.push([a.kind, reason]));
    const id = queue.push(alert("done", { createdAt: t }));
    queue.onShown(id);
    t += dwellMs - 1;
    queue.tick();
    assert.equal(queue.get(id).state, "shown");
    t += 1;
    queue.tick();
    assert.equal(queue.get(id), undefined);
    // Silent for the phone: a dismiss is the glasses' own doing.
    assert.deepEqual(closed, [["done", "dismissed"]]);
    t += TIMINGS.reminderMs * 3;
    queue.tick();
    assert.equal(frames.filter((f) => f.reason !== "update").length, 1);
  });
}

test("a_done_that_was_never_acked_keeps_retrying_instead_of_leaving", () => {
  const env = setup();
  const id = env.queue.push(alert("done", { createdAt: env.now() }));
  env.advance(5_000);
  env.advance(10_000);
  assert.equal(env.queue.get(id).state, "sent");
  assert.deepEqual(frameReasons(env), ["new", "retry", "retry"]);
});

test("an_unanswered_question_stays_pending_after_its_card_left_and_is_reminded", () => {
  const env = setup();
  const id = env.queue.push(alert("question", { createdAt: env.now() }));
  env.queue.onShown(id);
  env.advance(TIMINGS.dwellMs);
  assert.equal(env.queue.get(id).state, "shown");
  env.advance(TIMINGS.reminderMs - TIMINGS.dwellMs);
  assert.deepEqual(frameReasons(env), ["new", "reminder"]);
  assert.equal(env.queue.get(id).kind, "question");
});

test("an_error_is_reminded_like_an_approval_until_it_is_dismissed", () => {
  const env = setup();
  const id = env.queue.push(alert("error", { createdAt: env.now() }));
  env.queue.onShown(id);
  env.advance(TIMINGS.reminderMs);
  assert.deepEqual(frameReasons(env), ["new", "reminder"]);
  env.queue.onShown(id);
  env.queue.onDismissed(id);
  env.advance(TIMINGS.reminderMs * 2);
  assert.deepEqual(frameReasons(env), ["new", "reminder"]);
});

test("a_newer_alert_still_takes_the_display_when_the_dwell_is_over_and_the_old_one_stays_pending", () => {
  const env = setup({ ...TIMINGS, dwellMs: 60_000 });
  const first = env.queue.push(alert("question", { title: "first", createdAt: env.now() }));
  env.queue.onShown(first);
  env.queue.push(alert("error", { title: "second", createdAt: env.now() }));
  env.advance(59_999);
  assert.equal(env.queue.current().title, "first");
  env.advance(1);
  assert.equal(env.queue.current().title, "second");
  assert.equal(env.queue.get(first).state, "shown");
});

test("an_approval_preempts_a_done_inside_the_dwell_and_the_done_resumes_for_its_dwell", () => {
  const env = setup();
  const done = env.queue.push(alert("done", { title: "done", createdAt: env.now() }));
  env.queue.onShown(done);
  env.advance(3_000);
  const approval = env.queue.push(alert("approval", { title: "approval", createdAt: env.now() }));
  assert.equal(env.queue.current().id, approval);
  env.queue.onShown(approval);
  env.queue.onActed(approval);
  assert.equal(env.queue.current().id, done);
  env.queue.onShown(done);
  env.advance(TIMINGS.dwellMs);
  assert.equal(env.queue.get(done), undefined);
});

test("a_dwell_longer_than_the_glasses_can_hold_a_band_is_read_as_the_band_ceiling", () => {
  const env = setup({ ...TIMINGS, dwellMs: 3_600_000 });
  const id = env.queue.push(alert("done", { createdAt: env.now() }));
  env.queue.onShown(id);
  env.advance(MAX_BAND_DWELL_MS);
  assert.equal(env.queue.get(id), undefined);
});

test("a_reminder_due_at_or_past_the_wait_limit_is_still_sent_before_the_alert_expires", () => {
  for (const reminderMs of [300_000, 600_000, 3_600_000]) {
    // Wait limit 5 min, the reminder choice at or past it.
    const env = setup({ ...TIMINGS, expireMs: 300_000, reminderMs });
    const id = env.queue.push(alert("question", { createdAt: env.now() }));
    env.queue.onShown(id);
    env.advance(149_999);
    assert.deepEqual(frameReasons(env), ["new"]);
    env.advance(1);
    assert.deepEqual(frameReasons(env), ["new", "reminder"], `reminderMs ${reminderMs}`);
    assert.equal(env.queue.get(id).kind, "question");
  }
});
