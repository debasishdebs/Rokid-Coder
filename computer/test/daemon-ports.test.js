const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { withDaemon, freePort } = require("./helpers/daemon.js");

function health(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(JSON.parse(body)));
    }).once("error", reject);
  });
}

test("freePort never hands the same port out twice in one process", async () => {
  const ports = [];
  for (let round = 0; round < 20; round += 1) {
    ports.push(...(await Promise.all(Array.from({ length: 25 }, () => freePort()))));
  }
  assert.equal(new Set(ports).size, ports.length);
});

test("parallel_daemons_never_collide_on_ports", async () => {
  const count = 8;
  const started = [];
  let release;
  const everyoneUp = new Promise((resolve) => { release = resolve; });
  // Every daemon stays up until all of them are, so their ports are held together.
  const runs = Array.from({ length: count }, () =>
    withDaemon({ transport: "wshub" }, async ({ httpPort, wsPort }) => {
      started.push({ httpPort, wsPort });
      if (started.length === count) release();
      await everyoneUp;
      assert.equal((await health(httpPort)).ok, true);
    }),
  );
  await Promise.all(runs);
  const ports = started.flatMap(({ httpPort, wsPort }) => [httpPort, wsPort]);
  assert.equal(started.length, count);
  assert.equal(new Set(ports).size, ports.length);
});
