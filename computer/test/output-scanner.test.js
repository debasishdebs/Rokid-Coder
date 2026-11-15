const test = require("node:test");
const assert = require("node:assert/strict");
const { OutputScanner } = require("../dist/launcher/output-scanner.js");

test("marker_split_across_chunks_and_ansi_matched", () => {
  const scanner = new OutputScanner();
  // Colour, a title OSC, and the marker cut mid-word and mid-sequence.
  for (const chunk of ["\x1b[1;3", "2mSwi", "tch\x1b[0m", "\x1b]0;claude\x07", " mo", "del?\x1b[", "K\r\n"]) {
    scanner.push(chunk);
  }
  assert.equal(scanner.seen("Switch model?"), true);

  const spaced = new OutputScanner();
  // Ink may move the cursor instead of printing blanks; an OSC may end in ESC \ split across chunks.
  for (const chunk of ["Set\x1b[1Cmodel", "\x1b]8;;http://x\x1b", "\\ to", "  \x1b(Bhaiku"]) {
    spaced.push(chunk);
  }
  assert.equal(spaced.seen("Set model to"), true);
  assert.equal(spaced.text.includes("\x1b"), false, "nothing of a sequence is kept");
  assert.equal(spaced.seen("Switch model?"), false);
});

test("stale_marker_before_write_not_accepted", () => {
  // Only what is pushed into this scanner counts; it starts empty.
  const before = new OutputScanner();
  before.push("Switch model?\r\n");
  const after = new OutputScanner();
  after.push("> /model haiku\r\n");
  assert.equal(after.seen("Switch model?"), false);
  assert.equal(before.seen("Switch model?"), true);
});

test("scanner_bounded_at_8k", () => {
  const scanner = new OutputScanner();
  scanner.push("Switch model?");
  assert.equal(scanner.seen("Switch model?"), true);
  for (let i = 0; i < 100; i += 1) {
    scanner.push(`${"x".repeat(1000)}\r\n`);
  }
  assert.ok(scanner.text.length <= 8192, `kept ${scanner.text.length}`);
  assert.equal(scanner.seen("Switch model?"), true, "a marker already seen stays seen");

  // A watched marker inside one chunk far larger than the bound is still caught.
  const big = new OutputScanner(64);
  assert.equal(big.seen("Set model to"), false);
  big.push(`Set model to haiku${"y".repeat(10_000)}`);
  assert.ok(big.text.length <= 64);
  assert.equal(big.seen("Set model to"), true);
});

test("unterminated_osc_does_not_hide_later_output", () => {
  const scanner = new OutputScanner();
  scanner.push(`\x1b]0;${"t".repeat(5000)}`);
  scanner.push("Switch model?");
  assert.equal(scanner.seen("Switch model?"), true);
});
