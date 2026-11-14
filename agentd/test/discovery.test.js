const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { claudeSessionGone, discoverRecentSessions } = require("../dist/discovery.js");
const { silentLogger } = require("../dist/logger.js");

test("discovery titles use the last human user text and skip synthetic wrappers", async () => {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-agentd-discovery-"));
  const projectsDir = path.join(tempDir, "projects");
  const projectDir = path.join(projectsDir, "sample-project");
  const transcriptPath = path.join(projectDir, "session-title.jsonl");
  try {
    await fsp.mkdir(projectDir, { recursive: true });
    const entries = [
      { type: "user", message: { role: "user", content: "Earlier human title" } },
      { type: "user", message: { role: "user", content: "Latest human title" } },
      {
        type: "user",
        message: {
          role: "user",
          content: "  <task-notification>synthetic wrapper</task-notification>",
        },
      },
    ];
    await fsp.writeFile(
      transcriptPath,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const sessions = await discoverRecentSessions(projectsDir, silentLogger);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, "Latest human title");
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});

test("a_claude_session_is_gone_when_its_transcript_or_its_process_is", async () => {
  const claudeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-agentd-liveness-"));
  try {
    const transcript = path.join(claudeDir, "s1.jsonl");
    await fsp.writeFile(transcript, "{}\n");
    // No registry at all: only the transcript can tell.
    assert.equal(await claudeSessionGone(claudeDir, "s1", transcript), false);
    assert.equal(await claudeSessionGone(claudeDir, "s1", path.join(claudeDir, "deleted.jsonl")), true);

    const registry = path.join(claudeDir, "sessions");
    await fsp.mkdir(registry);
    await fsp.writeFile(path.join(registry, "4242.json"), JSON.stringify({ pid: 4242, sessionId: "s1" }));
    await fsp.writeFile(path.join(registry, "broken.json"), "{ not json");
    const alive = (pids) => (pid) => pids.includes(pid);
    assert.equal(await claudeSessionGone(claudeDir, "s1", transcript, alive([4242])), false, "its process runs");
    assert.equal(await claudeSessionGone(claudeDir, "s1", transcript, alive([])), true, "killed: the record outlived it");
    assert.equal(await claudeSessionGone(claudeDir, "s2", transcript, alive([4242])), true, "no process runs it");
  } finally {
    await fsp.rm(claudeDir, { recursive: true, force: true });
  }
});
