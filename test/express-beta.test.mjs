import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEVELOP_STEPS, developNext, expressAsk, expressResultAsk } from "../.claude/skills/express-addon-develop/scripts/lib/flow.mjs";
import { assertSafeArgv, poolUrls, stripEpoch, trustDevcert } from "../.claude/skills/express-addon-develop/scripts/lib/devcert.mjs";
import {
  checkTrusted,
  defaultProbe,
  detectAdapter,
  judgeExpress,
  launchSpec,
  prepareExpressRun,
  remoteReason,
  waitForDevServer
} from "../.claude/skills/express-addon-develop/scripts/lib/express-host.mjs";
import { readSession } from "../.claude/skills/express-addon-review/scripts/lib/session.mjs";
import { blockFetch, developCli, drive, expressRunCli, preloadFixtures, run } from "./drive-develop.mjs";

function isolatedEnv(out, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "develop-home-"));
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EXPRESS_REVIEW_NO_OPEN: "1",
    EXPRESS_REVIEW_OUT: out,
    EXPRESS_DEVELOP_OUT: out,
    EXPRESS_DEVELOP_KEEP_CACHE: "1",
    ...extra
  };
}

function atExpress({ mode = "chat", answer = "", develop = {}, asks = [], shots = [] } = {}) {
  const done = new Set(["docs", "origin", "template", "feasibility", "design", "implement", "build", "package", "audit"]);
  return {
    kind: "develop",
    mode,
    steps: DEVELOP_STEPS.map((step) => ({
      id: step.id,
      status: done.has(step.id) ? "done" : "pending",
      optional: Boolean(step.optional)
    })),
    asks: [...(answer ? [{ id: "express", status: "answered", answer }] : []), ...asks],
    shots,
    develop
  };
}

test("the beta question offers run, and skip stays first", () => {
  const ask = expressAsk();
  assert.match(ask.prompt, /Run a real test in Adobe Express \(beta\)\?/);
  assert.equal(ask.options[0].id, "skip");
  assert.match(ask.options[0].label, /Recommended/);
  assert.match(ask.options[0].detail, /listing/i);
  assert.equal(ask.options[1].id, "run");
  const result = expressResultAsk();
  assert.equal(result.options.map((item) => item.id).join(","), "rendered,failed,skip");
  assert.match(result.prompt, /localhost:5241/);
  assert.match(result.prompt, /127\.0\.0\.1/);
  assert.match(result.prompt, /never takes credentials/i);
});

test("dashboard mode asks the beta question on the dashboard, and chat mode asks in chat", () => {
  const dashboard = developNext(atExpress({ mode: "dashboard" }), { dashboardUp: true });
  assert.equal(dashboard.action, "ask");
  assert.equal(dashboard.ask, "express");
  assert.match(dashboard.command, /ask --id express/);
  assert.doesNotMatch(dashboard.say, /AskQuestion/);
  const chat = developNext(atExpress({ mode: "chat" }));
  assert.equal(chat.action, "ask-in-chat");
  assert.equal(chat.ask, "express");
  assert.match(chat.say, /AskQuestion/);
});

test("skip still continues straight to the listing", () => {
  const action = developNext(atExpress({ answer: "skip" }));
  assert.equal(action.action, "ask-in-chat");
  assert.equal(action.ask, "listing");
  assert.match(action.command, /ask --id listing/);
});

test("run starts the host command, and a remote result skips before listing", () => {
  const start = developNext(atExpress({ answer: "run" }));
  assert.match(start.command, /express-run\.mjs/);
  assert.doesNotMatch(start.command, /ignore-certificate/);
  const remote = developNext(atExpress({ answer: "run", develop: { expressChecked: true, expressRemote: true, expressPass: false } }));
  assert.equal(remote.ask, "listing");
  const published = developNext(atExpress({
    answer: "run",
    develop: { expressChecked: true, expressRemote: true },
    asks: [{ id: "listing", status: "answered", answer: "skip" }]
  }));
  assert.match(published.command, /--status skipped/);
  assert.match(published.command, /Remote machine/);
});

test("a real Express pass requires the panel, the feature, and a screenshot", () => {
  const shot = "shots/express.png";
  assert.equal(judgeExpress({ panelRendered: true, featureExercised: true, screenshot: shot }).expressPass, true);
  assert.equal(judgeExpress({ panelRendered: true, featureExercised: false, screenshot: shot }).expressPass, false);
  assert.equal(judgeExpress({ panelRendered: false, featureExercised: true, screenshot: shot }).expressPass, false);
  assert.equal(judgeExpress({ panelRendered: true, featureExercised: true, screenshot: "" }).expressPass, false);
  assert.equal(judgeExpress({ panelRendered: true, featureExercised: true, screenshot: shot, outcome: "timeout" }).expressPass, false);
  assert.equal(judgeExpress({ panelRendered: true, featureExercised: true, screenshot: shot, outcome: "failed" }).expressPass, false);
  const passed = developNext(atExpress({
    answer: "run",
    develop: { expressChecked: true, expressJudged: true, expressPass: true },
    asks: [{ id: "express-result", status: "answered", answer: "rendered" }, { id: "listing", status: "answered", answer: "skip" }]
  }));
  assert.match(passed.command, /Real Express pass/);
  const missed = developNext(atExpress({
    answer: "run",
    develop: { expressChecked: true, expressJudged: true, expressPass: false, expressOutcome: "incomplete" },
    asks: [{ id: "express-result", status: "answered", answer: "rendered" }, { id: "listing", status: "answered", answer: "skip" }]
  }));
  assert.match(missed.command, /Not an Express pass/);
  const waiting = developNext(atExpress({ answer: "run", develop: { expressChecked: true } }));
  assert.equal(waiting.ask, "express-result");
});

test("devcert trusts both NSS databases and falls back to the Debian pool", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devcert-home-"));
  const ca = path.join(home, "certificate.cert");
  fs.writeFileSync(ca, "fake-cert");
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args].join(" "));
    const command = calls.at(-1);
    if (command.startsWith("sudo DEBIAN_FRONTEND")) return { status: 1, stdout: "", stderr: "mirror down" };
    if (command.startsWith("dpkg-query")) return { status: 0, stdout: "1:3.87-1", stderr: "" };
    if (command.startsWith("dpkg --print-architecture")) return { status: 0, stdout: "amd64\n", stderr: "" };
    if (command.includes("debian-security")) return { status: 1, stdout: "", stderr: "404" };
    if (command.startsWith("curl")) return { status: 0, stdout: "", stderr: "" };
    if (command.startsWith("sudo dpkg")) return { status: 0, stdout: "", stderr: "" };
    if (command.includes(" -L")) return { status: 0, stdout: "adobe-ccweb-devcert                                          C,,\n", stderr: "" };
    if (command.includes(" -D ")) return { status: 1, stdout: "", stderr: "absent" };
    return { status: 0, stdout: "subject=CN=dev\nnotAfter=Jan 1 00:00:00 2030 GMT\n", stderr: "" };
  };
  const made = [];
  const result = trustDevcert({
    home,
    ca,
    certutilPresent: false,
    run,
    exists: (file) => file === ca,
    mkdir: (dir) => made.push(dir)
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.exitCode, 0);
  assert.equal(result.expressHostRan, false);
  assert.equal(result.expressPass, false);
  assert.match(result.message, /https:\/\/localhost:5241/);
  assert.match(result.message, /not 127\.0\.0\.1/);
  assert.deepEqual(result.install.urls, poolUrls("3.87-1", "amd64"));
  assert.equal(stripEpoch("2:3.98-1ubuntu0.2"), "3.98-1ubuntu0.2");
  const joined = calls.join("\n");
  assert.match(joined, /debian-security\/pool/);
  assert.match(joined, /debian\/pool/);
  assert.equal(calls.filter((item) => item.startsWith("curl")).length, 2);
  assert.match(joined, / -A -t C,, -n adobe-ccweb-devcert /);
  assert.equal(result.verified.length, 2);
  assert.ok(result.verified.every((item) => item.trusted));
  assert.equal(made.length, 2);
  assert.doesNotMatch(joined, /ignore-certificate/);
  assert.doesNotMatch(joined, /127\.0\.0\.1/);
  assert.throws(() => assertSafeArgv(["google-chrome", "--ignore-certificate-errors"]), /unsafe/i);
  assert.throws(() => assertSafeArgv(["https://127.0.0.1:5241"]), /unsafe/i);
});

test("a missing dev CA exits 2 and does not trust anything", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devcert-home-"));
  const calls = [];
  const result = trustDevcert({
    home,
    certutilPresent: true,
    run: (file, args) => {
      calls.push([file, ...args].join(" "));
      return { status: 0, stdout: "", stderr: "" };
    },
    exists: () => false
  });
  assert.equal(result.exitCode, 2);
  assert.match(result.error, /npm run start/);
  assert.equal(calls.some((item) => item.includes("certutil")), false);
  assert.equal(result.expressPass, false);
});

test("apt is not followed by the pool when apt works", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devcert-home-"));
  const ca = path.join(home, "ca.cert");
  const calls = [];
  const result = trustDevcert({
    home,
    ca,
    certutilPresent: false,
    run: (file, args) => {
      calls.push([file, ...args].join(" "));
      if (args.includes("-L")) return { status: 0, stdout: "devcert C,,", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
    exists: (file) => file === ca || file.endsWith("cert9.db")
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(calls.some((item) => item.startsWith("curl")), false);
  assert.equal(calls.some((item) => item.includes(" -N ")), false);
});

test("adapter detection prefers Cursor's browser tool, then local Chrome, and never launches when remote", () => {
  const probe = { cgroup: "0::/system.slice/pod-abc/init", dockerenv: false, containerenv: false };
  assert.match(remoteReason({ CURSOR_AGENT: "1" }, probe), /cgroup/);
  assert.equal(remoteReason({ EXPRESS_DEVELOP_REMOTE: "0", SSH_CONNECTION: "1" }, probe), "");
  assert.match(remoteReason({ SSH_CLIENT: "1" }, { cgroup: "" }), /SSH/);
  assert.match(remoteReason({}, { dockerenv: true }), /container/);
  let launched = 0;
  const remote = prepareExpressRun({
    env: { HOME: "/tmp/express-home", CURSOR_AGENT: "1" },
    probe,
    launch() {
      launched += 1;
    }
  });
  assert.equal(remote.skipped, true);
  assert.equal(remote.expressPass, false);
  assert.equal(remote.expressHostRan, false);
  assert.equal(launched, 0);

  const cursor = prepareExpressRun({
    env: { HOME: "/tmp/express-home", CURSOR_AGENT: "1", EXPRESS_DEVELOP_REMOTE: "0" },
    probe,
    launch() {
      launched += 1;
    }
  });
  assert.equal(cursor.skipped, false);
  assert.equal(cursor.adapter.id, "cursor-browser");
  assert.equal(cursor.launched, false);
  assert.equal(launched, 0);
  assert.match(cursor.spec.instructions.join("\n"), /cursor.com\/docs\/agent\/tools\/browser/);
  assert.equal(cursor.adapter.notes["claude-chrome"].verified, false);
  assert.equal(cursor.adapter.notes["codex-browser"].verified, false);
  assert.match(cursor.adapter.notes["claude-chrome"].note, /claude --chrome/);
  assert.match(cursor.adapter.notes["codex-browser"].note, /BrowserToolset/);

  const spec = launchSpec(detectAdapter(
    { HOME: "/tmp/express-home", CURSOR_AGENT: "", CHROME_PATH: "/opt/google-chrome" },
    { exists: (file) => file === "/opt/google-chrome", which: () => "" }
  ), { HOME: "/tmp/express-home" });
  assert.equal(spec.adapter, "local-chrome");
  assert.equal(spec.headless, false);
  assert.equal(spec.url, "https://new.express.adobe.com");
  assert.ok(spec.profile.endsWith(`${path.join(".config", "express-addon-develop", "chrome-profile")}`));
  assert.equal(spec.args.includes("--headless"), false);
  assert.doesNotMatch(spec.args.join(" "), /ignore-certificate|127\.0\.0\.1/);

  const edge = detectAdapter(
    { HOME: "/tmp/express-home", CURSOR_BROWSER_TOOL: "0", CURSOR_AGENT: "1" },
    { exists: (file) => file.endsWith("msedge"), which: (name) => (name === "msedge" ? "/usr/bin/msedge" : "") }
  );
  assert.equal(edge.id, "local-edge");
});

test("the dev server is started with npm start and only https://localhost:5241 counts as trusted", async () => {
  const calls = [];
  const ready = await waitForDevServer({
    cwd: "/tmp/addon",
    timeoutMs: 0,
    sleep: async () => {},
    spawnImpl(cmd, args, options) {
      calls.push({ cmd, args, options });
      return { pid: 42, unref() {} };
    },
    check: async (origin) => ({ ok: true, trusted: origin === "https://localhost:5241" })
  });
  assert.equal(ready.trusted, true);
  assert.equal(calls[0].cmd, "npm");
  assert.deepEqual(calls[0].args, ["start"]);
  assert.equal(calls[0].options.cwd, "/tmp/addon");
  assert.equal(calls[0].options.env, undefined);
  const timedOut = await waitForDevServer({
    cwd: "/tmp/addon",
    timeoutMs: 0,
    sleep: async () => {},
    spawnImpl: () => ({ pid: 7, unref() {} }),
    check: async () => ({ ok: false, trusted: false, error: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })
  });
  assert.equal(timedOut.outcome, "timeout");
  assert.equal(timedOut.trusted, false);
  const refused = await checkTrusted("https://127.0.0.1:5241");
  assert.equal(refused.trusted, false);
  assert.match(refused.error, /localhost:5241/);
});

test("a cloud-agent cgroup skips the real Express run and does not launch", () => {
  const probe = defaultProbe();
  const reason = remoteReason(process.env, probe);
  const cloud = /\/pod-/.test(`${process.env.CURSOR_WORKLOAD_CGROUP || ""}\n${probe.cgroup || ""}`);
  if (!cloud) return;
  assert.ok(reason);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out);
  assert.equal(run(developCli, ["begin", "--dir", fs.mkdtempSync(path.join(os.tmpdir(), "develop-empty-")), "--name", "Remote", "--brief", "caption", "--out", out], env, [blockFetch]).status, 0);
  const result = run(expressRunCli, ["--out", out], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.skipped, true);
  assert.equal(result.json.launched, false);
  assert.equal(result.json.expressPass, false);
  assert.equal(result.json.expressHostRan, false);
  assert.equal(result.json.credentials, "never handled");
  assert.match(result.json.reason, /cgroup|EXPRESS_DEVELOP_REMOTE|SSH|container/);
  const session = readSession(out);
  assert.equal(session.develop.expressRemote, true);
  assert.equal(session.develop.expressPass, false);
  assert.equal(session.develop.expressHostRan, false);
});

test("a mocked local launch records the browser spec and still is not a pass", () => {
  const chrome = path.join(os.tmpdir(), `fake-chrome-${process.pid}`);
  fs.writeFileSync(chrome, "");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out, {
    EXPRESS_DEVELOP_REMOTE: "0",
    EXPRESS_DEVELOP_MOCK_LAUNCH: "1",
    CURSOR_AGENT: "",
    CURSOR_BROWSER_TOOL: "0",
    CURSOR_WORKLOAD_CGROUP: "",
    SSH_CONNECTION: "",
    SSH_CLIENT: "",
    CHROME_PATH: chrome
  });
  assert.equal(run(developCli, ["begin", "--dir", fs.mkdtempSync(path.join(os.tmpdir(), "develop-empty-")), "--name", "Mock", "--brief", "caption", "--out", out], env, [blockFetch]).status, 0);
  const result = run(expressRunCli, ["--out", out], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.mock, true);
  assert.equal(result.json.expressPass, false);
  assert.equal(result.json.skipped, false);
  assert.equal(result.json.spec.adapter, "local-chrome");
  assert.equal(result.json.spec.url, "https://new.express.adobe.com");
  assert.equal(result.json.spec.headless, false);
  assert.doesNotMatch(result.json.spec.args.join(" "), /ignore-certificate|127\.0\.0\.1|headless/);
  assert.equal(result.json.credentials, "never handled");
  const questions = JSON.parse(fs.readFileSync(path.join(out, "questions.json"), "utf8"));
  assert.ok(questions.some((item) => item.id === "express-result"));
  const session = readSession(out);
  assert.equal(session.develop.expressPass, false);
  assert.equal(session.develop.expressHostRan, false);
});

test("choosing run on a remote machine skips Express and still reaches the listing", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out, { EXPRESS_DEVELOP_SCAFFOLD: "fixture", EXPRESS_DEVELOP_REMOTE: "1" });
  const began = run(developCli, ["begin", "--dir", fs.mkdtempSync(path.join(os.tmpdir(), "develop-empty-")), "--name", "beta-run", "--brief", "Add a caption field to the panel", "--out", out], env, [blockFetch]);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  const walked = drive(out, env, { imports: [preloadFixtures], audit: "skip", answers: { express: "run" } });
  const expressAt = walked.actions.indexOf("ask-in-chat:express");
  assert.equal(walked.actions[expressAt + 1], "run");
  assert.equal(walked.actions[expressAt + 2], "ask-in-chat:listing");
  assert.equal(walked.asked.includes("express-result"), false);
  const finished = readSession(out);
  assert.equal(finished.steps.find((step) => step.id === "express").status, "skipped");
  assert.equal(finished.develop.expressPass, false);
  assert.equal(finished.develop.expressHostRan, false);
  assert.equal(finished.develop.expressRemote, true);
});
