import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DEVELOP_STEPS, developNext } from "../.claude/skills/express-addon-develop/scripts/lib/flow.mjs";
import { prepareExpressRun } from "../.claude/skills/express-addon-develop/scripts/lib/express-host.mjs";
import { devRequestOptions, policyFailure, probeDevPort, readLoopbackPolicy } from "../.claude/skills/express-addon-develop/scripts/lib/loopback.mjs";

function session(develop) {
  const done = new Set(["planning", "plan", "docs", "design", "template", "implement", "build", "package", "audit", "try"]);
  return {
    kind: "develop",
    mode: "chat",
    steps: DEVELOP_STEPS.map((step) => ({ id: step.id, status: done.has(step.id) ? "done" : "pending" })),
    asks: [
      { id: "express", status: "answered", answer: "run" },
      { id: "listing", status: "answered", answer: "skip" }
    ],
    develop
  };
}

function listen(host) {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve({ server, port: server.address().port }));
  });
}

test("a LoopbackNetworkBlockedForUrls policy is named in the skip and in a failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-policy-"));
  const file = path.join(root, "managed", "block.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ LoopbackNetworkBlockedForUrls: ["*"] }, null, 2)}\n`;
  fs.writeFileSync(file, body);
  const hit = readLoopbackPolicy([root]);
  assert.equal(hit.blocks, true);
  assert.equal(hit.file, file);
  assert.equal(fs.readFileSync(file, "utf8"), body);

  let launched = 0;
  const local = prepareExpressRun({
    env: { HOME: "/tmp/express-home", EXPRESS_DEVELOP_REMOTE: "0", CURSOR_AGENT: "" },
    probe: { cgroup: "", dockerenv: false, containerenv: false },
    policyDirs: [root],
    launch() { launched += 1; }
  });
  assert.equal(local.skipped, true);
  assert.equal(local.launched, false);
  assert.equal(local.policyBlocked, true);
  assert.equal(launched, 0);
  assert.match(local.reason, /LoopbackNetworkBlockedForUrls/);
  assert.match(local.reason, /does not change that policy/);
  assert.match(local.reason, /npm run package/);
  assert.match(local.reason, /dist\.zip/);
  assert.match(local.reason, /Manage add-ons/);
  assert.match(local.reason, /Private link/);
  assert.match(local.reason, /250x250/);
  assert.match(local.reason, /Do not create the publisher profile or the listing/);

  const remote = prepareExpressRun({
    env: { HOME: "/tmp/express-home" },
    probe: { cgroup: "0::/system.slice/pod-abc/init", dockerenv: false, containerenv: false },
    policyDirs: [root]
  });
  assert.equal(remote.skipped, true);
  assert.match(remote.reason, /cgroup/);
  assert.match(remote.reason, /LoopbackNetworkBlockedForUrls/);

  const skip = developNext(session({
    expressChecked: true,
    expressPolicy: true,
    expressPass: false,
    expressReason: local.reason
  }));
  assert.match(skip.command, /--status skipped/);
  assert.match(skip.command, /LoopbackNetworkBlockedForUrls/);
  assert.match(skip.say, /LoopbackNetworkBlockedForUrls/);
  assert.match(skip.say, /does not change that policy/);
  assert.match(skip.command, /Private link/);
  assert.match(skip.command, /dist\.zip/);
  assert.match(skip.say, /250x250/);
  assert.match(skip.say, /Do not create the publisher profile or the listing/);

  const failed = developNext(session({
    expressChecked: true,
    expressBlocked: policyFailure("The development environment provided failed to load. Please check the PORT number", hit),
    expressReason: policyFailure("The development environment provided failed to load. Please check the PORT number", hit)
  }));
  assert.match(failed.command, /--status done/);
  assert.match(failed.command, /LoopbackNetworkBlockedForUrls/);
  assert.match(failed.say, /PORT/);
  assert.match(failed.say, /LoopbackNetworkBlockedForUrls/);
  assert.match(failed.say, /security flag/);

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-policy-other-"));
  fs.mkdirSync(path.join(other, "managed"), { recursive: true });
  fs.writeFileSync(path.join(other, "managed", "ok.json"), `${JSON.stringify({ LoopbackNetworkBlockedForUrls: ["https://example.com/*"] })}\n`);
  const clean = readLoopbackPolicy([other]);
  assert.equal(clean.blocks, false);
  const allowed = prepareExpressRun({
    env: { HOME: "/tmp/express-home", EXPRESS_DEVELOP_REMOTE: "0", CURSOR_AGENT: "", CURSOR_BROWSER_TOOL: "0" },
    probe: { cgroup: "", dockerenv: false, containerenv: false },
    policyDirs: [other],
    exists: () => false,
    which: () => ""
  });
  assert.equal(allowed.skipped, false);
});

test("the dev server probe reports [::1] when 127.0.0.1 refuses", async () => {
  const v6 = await listen("::1");
  try {
    const found = await probeDevPort(v6.port);
    assert.deepEqual(found.listening, ["[::1]"]);
    assert.deepEqual(found.refused, ["127.0.0.1"]);
    assert.equal(found.host, "::1");
    assert.match(found.report, /\[::1\]/);
    assert.match(found.report, /127\.0\.0\.1/);
    assert.match(found.report, /refused/);
    assert.match(found.report, /ccweb-add-on-scripts/);
    const options = devRequestOptions(found.host, found.port);
    assert.equal(options.host, "::1");
    assert.equal(options.servername, "localhost");
    assert.equal(options.rejectUnauthorized, true);
  } finally {
    v6.server.close();
  }

  const v4 = await listen("127.0.0.1");
  try {
    const found = await probeDevPort(v4.port);
    assert.deepEqual(found.listening, ["127.0.0.1"]);
    assert.deepEqual(found.refused, ["[::1]"]);
    assert.match(found.report, /127\.0\.0\.1 only/);
    assert.match(found.report, /\[::1\] refused/);
  } finally {
    v4.server.close();
  }
});
