import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDevDocs } from "../.claude/skills/express-addon-develop/scripts/lib/docs-live.mjs";
import { expressResultAsk, feasibilityAsk, initialQuestions, templateAsk } from "../.claude/skills/express-addon-develop/scripts/lib/flow.mjs";
import { manifest, project } from "./helpers.mjs";
import { developSkill, preloadFixtures, reviewSkill } from "./drive-develop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function homeEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "develop-home-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EXPRESS_REVIEW_NO_OPEN: "1",
    EXPRESS_DEVELOP_KEEP_CACHE: "1",
    ...extra
  };
  delete env.EXPRESS_DEVELOP_OUT;
  delete env.EXPRESS_REVIEW_OUT;
  return { home, env };
}

function runAt(args, env, timeout = 180000) {
  return spawnSync(process.execPath, args, { cwd: developSkill, env, encoding: "utf8", timeout });
}

function jsonOf(result) {
  const text = String(result.stdout || "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const line = text.split("\n").map((item) => item.trim()).filter((item) => item.startsWith("{")).at(-1);
    return line ? JSON.parse(line) : null;
  }
}

function tokenize(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match = pattern.exec(command);
  while (match) {
    tokens.push(match[1] ?? match[2]);
    match = pattern.exec(command);
  }
  return tokens;
}

function runPrinted(command, env) {
  const tokens = tokenize(command);
  assert.equal(tokens[0], "node", command);
  assert.equal(tokens.some((item) => item === "--out"), false, command);
  const args = tokens.slice(1);
  args[0] = args[0].replace(/^node\s+/, "");
  return runAt(args, env);
}

test("a develop page uses plain words, and a review page still counts code errors", () => {
  const app = fs.readFileSync(path.join(reviewSkill, "assets/dashboard/app.js"), "utf8");
  const server = fs.readFileSync(path.join(reviewSkill, "scripts/lib/server.mjs"), "utf8");
  assert.match(app, /Adobe docs, \$\{when\}/);
  assert.match(app, /Adobe docs on this computer/);
  assert.doesNotMatch(app, /docsSha/);
  assert.match(app, /No code-error list for this build/);
  assert.match(app, /session\(\)\?\.kind === "develop"/);
  assert.match(app, /k: "Code errors"/);
  assert.match(server, /<title>Dashboard<\/title>/);
  assert.doesNotMatch(server, /Review dashboard/);
  assert.equal(manifest.manifestVersion, 2);
  assert.match(JSON.stringify(manifest.requirements.apps), /Express/);
  assert.equal(manifest.entryPoints[0].id, "panel1");
});

test("every develop choice has one recommended option, and it is listed first", () => {
  const questions = [
    ...initialQuestions(),
    templateAsk(["javascript", "react-javascript"]),
    feasibilityAsk({ class: "iframe", summary: "Panel UI." }),
    expressResultAsk()
  ];
  for (const question of questions) {
    assert.equal(question.options.filter((option) => /\(Recommended\)$/.test(option.label)).length, 1, question.id);
    assert.match(question.options[0].label, /\(Recommended\)$/, question.id);
    assert.equal(question.options.some((option) => /[a-f0-9]{12,}/i.test(option.label + option.detail)), false, question.id);
  }
  assert.equal(expressResultAsk().options[0].id, "skip");
});

test("a hung doc fetch ends with the budget and does not keep the process waiting", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "docs-cache-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "docs-dest-"));
  const started = Date.now();
  const result = await fetchDevDocs({
    pages: ["slow.md"],
    cacheDir: cache,
    destDir: dest,
    budgetMs: 350,
    pageMs: 200,
    fetchImpl: () => new Promise(() => {})
  });
  assert.ok(Date.now() - started < 1500, "a fetch that ignores abort must still end");
  assert.equal(result.counts.failed, 1);
  assert.equal(result.pages[0].label, "failed");
  const fast = Date.now();
  const fresh = await fetchDevDocs({
    pages: ["ok.md"],
    cacheDir: cache,
    destDir: dest,
    budgetMs: 8000,
    pageMs: 8000,
    fetchImpl: async () => ({ ok: true, text: async () => "a sentence" })
  });
  assert.ok(Date.now() - fast < 1000);
  assert.equal(fresh.counts.fresh, 1);
});

test("a failed or stale page is a label, not a step status", () => {
  const { env } = homeEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "develop-addon-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const began = runAt(["scripts/develop.mjs", "begin", "--dir", dir, "--empty", "--name", "caption-addon", "--brief", "Add a caption field", "--out", out], env);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  assert.equal(jsonOf(began).empty, true);
  assert.equal(runAt(["scripts/session.mjs", "mode", "--set", "chat"], env).status, 0);
  const docs = runAt(["--import", preloadFixtures, "scripts/develop.mjs", "docs", "--out", out], env);
  assert.equal(docs.status, 0, docs.stdout + docs.stderr);
  const session = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
  const allowed = new Set(["pending", "running", "waiting", "done", "skipped"]);
  for (const step of session.steps) assert.equal(allowed.has(step.status), true, step.id);
  assert.equal(session.steps.find((step) => step.id === "docs").status, "done");
  assert.ok(session.docs.pages.some((page) => page.label === "stale" || page.label === "failed" || page.label === "fresh"));
  const refused = runAt(["scripts/session.mjs", "step", "--id", "docs", "--status", "failed", "--detail", "no"], env);
  assert.notEqual(refused.status, 0);
  assert.match(`${refused.stdout}\n${refused.stderr}`, /Unknown status/);
});

test("--empty is honored, and a non-empty folder is not wiped", () => {
  const { env } = homeEnv();
  const filled = fs.mkdtempSync(path.join(os.tmpdir(), "develop-filled-"));
  fs.writeFileSync(path.join(filled, "keep.txt"), "keep");
  const refused = runAt(["scripts/develop.mjs", "begin", "--empty", "--dir", filled, "--name", "caption-addon", "--brief", "caption"], env);
  assert.notEqual(refused.status, 0);
  assert.match(jsonOf(refused).error, /nothing in the folder was deleted/);
  assert.match(jsonOf(refused).next, /No session was created/);
  assert.match(jsonOf(refused).next, /Do not run session\.mjs next/);
  assert.doesNotMatch(jsonOf(refused).next, /review\.mjs/);
  assert.equal(fs.readFileSync(path.join(filled, "keep.txt"), "utf8"), "keep");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "develop-empty-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const began = runAt(["scripts/develop.mjs", "begin", "--empty", "--dir", empty, "--name", "caption-addon", "--brief", "Add a caption field", "--out", out], env);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  assert.equal(jsonOf(began).empty, true);
  assert.equal(jsonOf(began).existing, false);
});

test("an existing add-on skips the empty-folder question", () => {
  const { env } = homeEnv({ NODE_OPTIONS: `--import ${preloadFixtures}` });
  const dir = project({ "index.html": "<!doctype html><html><body><h1>Already</h1></body></html>\n" });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  assert.equal(runAt(["scripts/develop.mjs", "begin", "--dir", dir, "--name", "Already", "--brief", "Add a caption field", "--out", out], env).status, 0);
  assert.equal(runAt(["scripts/session.mjs", "mode", "--set", "chat"], env).status, 0);
  assert.equal(runAt(["scripts/develop.mjs", "docs"], env).status, 0);
  const next = jsonOf(runAt(["scripts/session.mjs", "next"], env));
  assert.notEqual(next.ask, "origin");
  assert.notEqual(next.ask, "template");
  assert.match(next.command, /classify/);
  const session = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
  assert.equal(session.steps.find((step) => step.id === "template").status, "skipped");
});

test("re-running begin resumes, and a second start does not wipe answers", () => {
  const { home, env } = homeEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "develop-addon-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  assert.equal(runAt(["scripts/develop.mjs", "begin", "--dir", dir, "--empty", "--name", "Keep", "--brief", "caption", "--out", out], env).status, 0);
  fs.writeFileSync(path.join(dir, "keep.txt"), "keep");
  assert.equal(runAt(["scripts/session.mjs", "mode", "--set", "dashboard"], env).status, 0);
  const started = jsonOf(runAt(["scripts/dashboard.mjs", "start", "--no-open"], env));
  assert.equal(started.ok, true, JSON.stringify(started));
  const classified = jsonOf(runAt(["scripts/develop.mjs", "classify"], env));
  assert.match(classified.next, /next/i);
  assert.doesNotMatch(classified.next, /dashboard is not running/);
  assert.equal(runAt(["scripts/session.mjs", "ask", "--id", "origin"], env).status, 0);
  const server = JSON.parse(fs.readFileSync(path.join(out, "server.json"), "utf8"));
  const origin = started.url.split("?")[0].replace(/\/$/, "");
  const posted = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const res = await fetch(${JSON.stringify(`${origin}/api/answer?t=${server.token}`)}, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ${JSON.stringify(origin)} },
      body: JSON.stringify({ id: "origin", value: "new" })
    });
    const body = await res.json();
    process.stdout.write(JSON.stringify({ status: res.status, body }));
  `], { encoding: "utf8" });
  assert.equal(posted.status, 0, posted.stdout + posted.stderr);
  assert.equal(JSON.parse(posted.stdout).status, 200);
  const answers = fs.readFileSync(path.join(out, "answers.jsonl"), "utf8");
  assert.match(answers, /"value":"new"/);
  assert.equal(runAt(["scripts/dashboard.mjs", "stop"], env).status, 0);
  const again = jsonOf(runAt(["scripts/dashboard.mjs", "start", "--no-open"], env));
  assert.equal(again.ok, true);
  assert.equal(fs.readFileSync(path.join(out, "answers.jsonl"), "utf8"), answers);
  assert.equal(runAt(["scripts/dashboard.mjs", "stop"], env).status, 0);
  const realPointer = path.join(os.homedir(), ".express-addon-develop", "current.json");
  const before = fs.existsSync(realPointer) ? fs.statSync(realPointer).mtimeMs : 0;
  const resumed = jsonOf(runAt(["scripts/develop.mjs", "begin", "--dir", dir, "--name", "Keep", "--brief", "caption", "--out", out], env));
  assert.equal(resumed.resumed, true);
  assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "keep");
  assert.equal(fs.readFileSync(path.join(out, "answers.jsonl"), "utf8"), answers);
  const pointer = JSON.parse(fs.readFileSync(path.join(home, ".express-addon-develop", "current.json"), "utf8"));
  assert.equal(pointer.out, out);
  const after = fs.existsSync(realPointer) ? fs.statSync(realPointer).mtimeMs : 0;
  assert.equal(after, before);
});

test("a second session does not stop the previous dashboard", () => {
  const { home, env } = homeEnv();
  const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), "develop-a-"));
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "develop-b-"));
  const firstOut = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-a-"));
  const secondOut = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-b-"));
  assert.equal(runAt(["scripts/develop.mjs", "begin", "--dir", firstDir, "--empty", "--name", "One", "--brief", "caption", "--out", firstOut], env).status, 0);
  assert.equal(runAt(["scripts/session.mjs", "mode", "--set", "dashboard"], env).status, 0);
  const started = jsonOf(runAt(["scripts/dashboard.mjs", "start", "--no-open"], env));
  assert.equal(started.ok, true);
  const pid = started.pid;
  assert.equal(runAt(["scripts/develop.mjs", "begin", "--dir", secondDir, "--empty", "--name", "Two", "--brief", "caption", "--out", secondOut], env).status, 0);
  spawnSync("sleep", ["0.4"]);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, true);
  assert.equal(fs.existsSync(path.join(firstOut, "server.json")), true);
  const pointer = JSON.parse(fs.readFileSync(path.join(home, ".express-addon-develop", "current.json"), "utf8"));
  assert.equal(pointer.out, secondOut);
  const status = jsonOf(runAt(["scripts/dashboard.mjs", "status", "--out", firstOut], env));
  assert.equal(status.running, true);
  const next = jsonOf(runAt(["scripts/dashboard.mjs", "start", "--no-open", "--out", secondOut], env));
  assert.equal(next.ok, true);
  assert.equal(runAt(["scripts/dashboard.mjs", "stop", "--out", firstOut], env).status, 0);
  assert.equal(runAt(["scripts/dashboard.mjs", "stop", "--out", secondOut], env).status, 0);
});

test("listing screenshots are not claimed when Chrome is not started", () => {
  const { env } = homeEnv({ SKIP_BROWSER_TESTS: "1", NODE_OPTIONS: `--import ${preloadFixtures}` });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "develop-addon-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  assert.equal(runAt(["scripts/develop.mjs", "begin", "--dir", dir, "--empty", "--name", "caption-addon", "--brief", "caption", "--out", out], env).status, 0);
  const started = Date.now();
  const shots = runAt(["scripts/develop.mjs", "listing-shots"], env);
  assert.equal(shots.status, 0, shots.stdout + shots.stderr);
  assert.ok(Date.now() - started < 5000);
  const body = jsonOf(shots);
  assert.equal(body.skipped, true);
  assert.equal(body.rendered, false);
  assert.equal(body.capturedOn, "not captured");
  assert.equal(body.expressPass, false);
  assert.match(body.reason, /Chrome or Edge/);
  assert.match(body.next, /next/);
});

test("the printed next lines reach the handoff", { timeout: 300000 }, () => {
  const { env } = homeEnv({
    EXPRESS_DEVELOP_SCAFFOLD: "fixture",
    NODE_OPTIONS: `--import ${preloadFixtures}`
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "develop-addon-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const began = runAt(["scripts/develop.mjs", "begin", "--empty", "--dir", dir, "--name", "caption-addon", "--brief", "Add a caption field to the panel", "--out", out], env);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  assert.match(jsonOf(began).next, /session\.mjs mode --set/);
  const answers = {
    plan: "build",
    origin: "new",
    template: "javascript",
    feasibility: "iframe",
    design: "leave",
    feedback: "good",
    express: "skip",
    listing: "skip"
  };
  const actions = [];
  for (let i = 0; i < 64; i += 1) {
    const next = runAt(["scripts/session.mjs", "next"], env);
    assert.equal(next.status, 0, next.stdout + next.stderr);
    const action = jsonOf(next);
    actions.push(action.ask ? `${action.action}:${action.ask}` : action.action);
    if (action.action === "finished") break;
    if (action.action === "ask-mode") {
      const mode = runAt(["scripts/session.mjs", "mode", "--set", "chat"], env);
      assert.equal(mode.status, 0, mode.stdout + mode.stderr);
      assert.match(mode.stdout, /"next"/);
      continue;
    }
    if (action.action === "ask" || action.action === "ask-in-chat") {
      const asked = runPrinted(action.command, env);
      assert.equal(asked.status, 0, `${action.command}\n${asked.stdout}\n${asked.stderr}`);
      const value = answers[action.ask];
      assert.ok(value, action.ask);
      const answered = runAt(["scripts/session.mjs", "answer", "--id", action.ask, "--value", value], env);
      assert.equal(answered.status, 0, answered.stdout + answered.stderr);
      const waited = jsonOf(runAt(["scripts/session.mjs", "wait", "--id", action.ask, "--timeout", "1"], env));
      assert.equal(waited.status, "answered");
      continue;
    }
    if (action.action === "awaiting-agent-implementation") {
      const sessionNow = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
      const htmlNow = path.join(sessionNow.addon.path, "src/index.html");
      const source = fs.readFileSync(htmlNow, "utf8");
      if (!source.includes("caption-field")) {
        const block = `<label for="caption-field">Caption</label>\n<input id="caption-field" name="caption" type="text" />\n`;
        fs.writeFileSync(htmlNow, source.includes("</body>") ? source.replace("</body>", `${block}</body>`) : `${source}\n${block}`);
      }
    }
    if (String(action.command || "").includes("develop.mjs feedback")) {
      const skipped = runAt(["scripts/develop.mjs", "feedback", "--skip"], env);
      assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
      continue;
    }
    assert.ok(action.command, JSON.stringify(action));
    const ran = runPrinted(action.command, env);
    assert.equal(ran.status, 0, `${action.command}\n${ran.stdout}\n${ran.stderr}`);
    assert.match(ran.stdout, /"next"/);
    if (i === 63) assert.fail(actions.join(" > "));
  }
  assert.equal(actions.at(-1), "finished");
  assert.equal(actions.includes("ask-in-chat:express"), true);
  assert.equal(actions[actions.indexOf("ask-in-chat:express") + 1], "ask-in-chat:listing");
  const session = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
  assert.equal(session.steps.find((step) => step.id === "done").status, "done");
  assert.equal(session.steps.find((step) => step.id === "express").status, "skipped");
  assert.equal(session.develop.expressPass, false);
  assert.notEqual(session.summary, null);
  const htmlPath = path.join(session.addon.path, "src", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /caption-field/);
  assert.doesNotMatch(html, /develop-feature|function featureReady/);
  fs.appendFileSync(htmlPath, "\n<!-- KEEP -->\n");
  const again = runAt(["scripts/develop.mjs", "implement"], env);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(fs.readFileSync(htmlPath, "utf8"), /KEEP/);
  const record = JSON.parse(fs.readFileSync(path.join(out, "browser-run.json"), "utf8"));
  assert.equal(record.expressPass, false);
  assert.equal(record.rendered, process.env.SKIP_BROWSER_TESTS ? false : true);
  assert.notEqual(record.capturedOn, "cloud");
  const resumed = jsonOf(runAt(["scripts/develop.mjs", "begin", "--dir", dir, "--name", "caption-addon", "--brief", "Add a caption field to the panel", "--out", out], env));
  assert.equal(resumed.resumed, undefined);
  assert.notEqual(resumed.out, out);
  assert.equal(JSON.parse(fs.readFileSync(path.join(resumed.out, "session.json"), "utf8")).steps.find((step) => step.id === "done").status, "pending");
  assert.match(fs.readFileSync(htmlPath, "utf8"), /KEEP/);
});

test("a killed dashboard is started again without losing the answer", () => {
  const { env } = homeEnv();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "develop-addon-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  assert.equal(runAt(["scripts/develop.mjs", "begin", "--empty", "--dir", dir, "--name", "Dash", "--brief", "caption", "--out", out], env).status, 0);
  assert.equal(runAt(["scripts/session.mjs", "mode", "--set", "dashboard"], env).status, 0);
  const started = jsonOf(runAt(["scripts/dashboard.mjs", "start", "--no-open"], env));
  assert.equal(runAt(["scripts/session.mjs", "ask", "--id", "origin"], env).status, 0);
  assert.equal(runAt(["scripts/session.mjs", "answer", "--id", "origin", "--value", "new"], env).status, 0);
  const answers = fs.readFileSync(path.join(out, "answers.jsonl"), "utf8");
  process.kill(started.pid, "SIGKILL");
  spawnSync("sleep", ["0.3"]);
  const next = jsonOf(runAt(["scripts/session.mjs", "next"], env));
  assert.equal(next.action, "start-dashboard");
  assert.match(next.command, /dashboard\.mjs start/);
  const restarted = jsonOf(runPrinted(next.command, env));
  assert.equal(restarted.ok, true);
  assert.equal(fs.readFileSync(path.join(out, "answers.jsonl"), "utf8"), answers);
  assert.equal(runAt(["scripts/dashboard.mjs", "stop"], env).status, 0);
});

test("npx skills add layout keeps both skills and the files they import", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "skills-add-"));
  fs.cpSync(reviewSkill, path.join(dest, "express-addon-review"), { recursive: true });
  fs.cpSync(developSkill, path.join(dest, "express-addon-develop"), { recursive: true });
  const usage = spawnSync(process.execPath, ["scripts/develop.mjs"], { cwd: path.join(dest, "express-addon-develop"), encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stdout, /begin\|docs\|templates/);
  const loaded = spawnSync(process.execPath, ["-e", "await import('./scripts/lib/next.mjs')"], {
    cwd: path.join(dest, "express-addon-review"),
    encoding: "utf8"
  });
  assert.equal(loaded.status, 0, loaded.stdout + loaded.stderr);
  for (const skill of ["express-addon-review", "express-addon-develop"]) {
    const base = path.join(dest, skill);
    const files = walk(base).filter((file) => file.endsWith(".mjs"));
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/from "(\.[^"]+)"/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        const candidates = [target, `${target}.mjs`, path.join(target, "index.mjs")];
        assert.equal(candidates.some((item) => fs.existsSync(item)), true, `${path.relative(dest, file)} -> ${match[1]}`);
      }
    }
  }
});

test("tests resolve paths from the file when the working directory is not the repo", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const file = path.join(root, "test/real-use-path.test.mjs");
  for (const reporter of ["tap", "spec"]) {
    const result = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, file], {
      cwd: "/tmp",
      encoding: "utf8",
      env
    });
    const text = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
    assert.equal(result.status, 0, text);
    assert.match(text, /^(?:#|ℹ) pass 1$/m, text);
    assert.match(text, /^(?:#|ℹ) fail 0$/m, text);
  }
});

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "references") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}
