const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  MAX_TAILNET_PEERS,
  TailscalePeerDiscovery,
  selectTailnetPeers,
} = require("../dist/tailnet-discovery.js");

async function fixture() {
  const raw = await fsp.readFile(
    path.join(__dirname, "fixtures", "tailscale-status.json"),
    "utf8",
  );
  return { raw, status: JSON.parse(raw) };
}

function loggerHarness() {
  const entries = [];
  return {
    entries,
    logger: {
      info(event, meta) { entries.push({ level: "info", event, meta }); },
      warn(event, meta) { entries.push({ level: "warn", event, meta }); },
      error(event, meta) { entries.push({ level: "error", event, meta }); },
    },
  };
}

test("tailnet peer selection keeps only online Android CGNAT IPv4 peers and caps at eight", async () => {
  const { status } = await fixture();
  const selection = selectTailnetPeers(status);

  assert.equal(MAX_TAILNET_PEERS, 8);
  assert.deepEqual(
    selection.targets,
    Array.from({ length: 8 }, (_, index) => `100.64.0.${index + 1}:8792`),
  );
  assert.equal(selection.dropped, 2);
  assert.equal(selection.targets.some((target) => target.includes("100.65.0")), false);
  assert.equal(selection.targets.some((target) => target.includes("100.128.0")), false);
});

test("NoState and malformed status values produce empty discovery results", () => {
  assert.deepEqual(
    selectTailnetPeers({ BackendState: "NoState", Peer: { ignored: {} } }),
    { targets: [], dropped: 0 },
  );
  assert.deepEqual(selectTailnetPeers({ Peer: [] }), { targets: [], dropped: 0 });
  assert.deepEqual(selectTailnetPeers(null), { targets: [], dropped: 0 });
});

test("tailscale resolution falls back once, caches the binary, and logs only peer state changes", async () => {
  const { raw } = await fixture();
  const calls = [];
  let status = raw;
  const logs = loggerHarness();
  const discovery = new TailscalePeerDiscovery(
    logs.logger,
    async (binary) => {
      calls.push(binary);
      if (binary === "tailscale") {
        return { missing: true };
      }
      return { missing: false, stdout: status };
    },
    "win32",
  );

  assert.equal((await discovery.discover()).length, 8);
  assert.equal((await discovery.discover()).length, 8);
  status = "not json";
  assert.deepEqual(await discovery.discover(), []);
  assert.deepEqual(await discovery.discover(), []);

  assert.deepEqual(calls, [
    "tailscale",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
    "C:\\Program Files\\Tailscale\\tailscale.exe",
  ]);
  assert.deepEqual(
    logs.entries.filter((entry) =>
      entry.event === "tailnet_discovery_found" || entry.event === "tailnet_discovery_lost"
    ).map((entry) => entry.event),
    ["tailnet_discovery_found", "tailnet_discovery_lost"],
  );
  assert.equal(
    logs.entries.filter((entry) => entry.event === "tailnet_discovery_capped").length,
    1,
  );
});

test("tailnet_discovery_uses_tailscale_exe_via_interop", async () => {
  const { tailscaleExecutableCandidates } = require("../dist/tailnet-discovery.js");
  const { isWsl } = require("../dist/advertise.js");
  // Inside WSL the Windows client is the one that knows the tailnet: interop first.
  assert.deepEqual(tailscaleExecutableCandidates("linux", true), [
    "tailscale.exe",
    "/mnt/c/Program Files/Tailscale/tailscale.exe",
    "tailscale",
    "/usr/bin/tailscale",
  ]);
  assert.deepEqual(tailscaleExecutableCandidates("linux", false), ["tailscale", "/usr/bin/tailscale"]);
  assert.deepEqual(tailscaleExecutableCandidates("darwin", false), ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, () => false), true);
  assert.equal(isWsl({}, (file) => file === "/proc/sys/fs/binfmt_misc/WSLInterop"), true);
  assert.equal(isWsl({}, () => false), false);

  const { raw } = await fixture();
  const calls = [];
  const discovery = new TailscalePeerDiscovery(
    loggerHarness().logger,
    async (binary) => {
      calls.push(binary);
      return binary === "/mnt/c/Program Files/Tailscale/tailscale.exe" ? { missing: false, stdout: raw } : { missing: true };
    },
    "linux",
    true,
  );
  assert.equal((await discovery.discover()).length, 8);
  assert.deepEqual(calls, ["tailscale.exe", "/mnt/c/Program Files/Tailscale/tailscale.exe"]);
});
