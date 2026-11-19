"use strict";
/**
 * agentd's side of the screen-ready route against a fake launcher port: a session whose Claude file says
 * `status`, in permission mode `mode`, and whose launcher last reported `report` (a box state, or none).
 * Fakes only; the launcher's own half is typist-bg.test.js and draft-screen.test.js.
 */
const { SessionStates, LauncherRouter } = require("../../dist/launcher/session-state.js");

const KEY = "claude:s1";
const PID = 4242;
const TIMINGS = { readyWaitMs: 400, compactLimitMs: 400, pollMs: 10, bgAcceptMs: 150 };

function fakePort() {
  const written = [];
  const changes = [];
  const port = {
    bindings: new Map([[KEY, { gen: 1, claudePid: PID, uncertain: false }]]),
    drafts: new Map(),
    sent: [],
    pending: undefined,
    binding: (key) => (port.bindings.has(key) ? { ...port.bindings.get(key) } : undefined),
    boundKeys: () => [...port.bindings.keys()],
    unboundReason: () => undefined,
    send(key, cmd) {
      port.sent.push({ key, ...cmd });
      return new Promise((resolve) => {
        port.pending = { key, cmdId: cmd.cmdId, resolve };
      });
    },
    cancel() {},
    cancelCommand(cmdId) {
      if (port.pending?.cmdId === cmdId) port.settle({ ok: false, error: "cancelled" });
    },
    setUncertain(key, uncertain) {
      port.bindings.get(key).uncertain = uncertain;
    },
    laptopDraft: (key) => port.drafts.get(key) === true,
    promptSubmitted() {},
    compactDone() {},
    onChange: (cb) => changes.push(cb),
    onCommandWritten: (cb) => written.push(cb),
    onLateResult() {},
    onWriteCheck: (cb) => {
      port.checker = cb;
    },
    wrote(at = Date.now()) {
      for (const cb of written) cb(port.pending.key, port.pending.cmdId, at);
    },
    check: (phase) => port.checker(KEY, port.pending?.cmdId, phase),
    settle(result) {
      const pending = port.pending;
      port.pending = undefined;
      pending?.resolve(result);
    },
  };
  return port;
}

/**
 * `mode`: the permission mode the last main-thread hook carried. `status`: Claude's sessions file. `report`:
 * the launcher's last box state, or undefined for none (`ageMs` says how old it is).
 */
function setup(options = {}) {
  const { mode = "auto", status = "busy", ageMs = 0, asking = false, held = false, subagents = 0 } = options;
  // An explicit `report: undefined` is no report at all, not the default.
  const report = "report" in options ? options.report : "empty";
  const port = fakePort();
  const file = { status, statusUpdatedAt: Date.now() - 5000, sessionId: "s1" };
  const flags = { held, asking, report, ageMs, subagents };
  const states = new SessionStates(
    (pid) => (pid === PID ? { ...file } : undefined),
    Date.now,
    {
      binding: (key) => port.binding(key),
      held: () => flags.held,
      asking: () => flags.asking,
      clearUncertain: (key) => port.setUncertain(key, false),
      subagents: () => flags.subagents,
      approvalPending: () => flags.asking,
      screen: () => (flags.report === undefined ? undefined : { box: flags.report, ageMs: flags.ageMs }),
    },
  );
  const router = new LauncherRouter({ port, states, timings: TIMINGS, bgReplies: () => false });
  // One main-thread hook that carries the mode: it is sticky from then on.
  router.onHook(KEY, "UserPromptSubmit", { permission_mode: mode, prompt: "go" });
  return { port, file, flags, states, router };
}

module.exports = { KEY, PID, TIMINGS, fakePort, setup };
