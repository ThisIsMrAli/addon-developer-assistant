import test from "node:test";
import assert from "node:assert/strict";
import { capturedShots } from "./helpers.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shoot } from "../.claude/skills/express-addon-review/scripts/lib/chrome.mjs";
import { lintPage, unquotedPhrases, addonCorpus } from "../.claude/skills/express-addon-review/scripts/lib/listing.mjs";
import { developNext, recommendTemplate } from "../.claude/skills/express-addon-develop/scripts/lib/flow.mjs";
import { classifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/feasibility.mjs";
import { fetchDevDocs } from "../.claude/skills/express-addon-develop/scripts/lib/docs-live.mjs";
import { openDevServer, waitForDevServer } from "../.claude/skills/express-addon-develop/scripts/lib/express-host.mjs";
import { fillListingDir } from "../.claude/skills/express-addon-develop/scripts/lib/listing-copy.mjs";
import { serveWithStandIn } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { developCli, preloadFixtures, run, sessionCli } from "./drive-develop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewSkill = path.join(root, ".claude/skills/express-addon-review");
const architecture = fs.readFileSync(path.join(reviewSkill, "references/live/src/pages/guides/learn/platform-concepts/architecture.md"), "utf8");
const guide = fs.readFileSync(path.join(reviewSkill, "references/live/src/pages/guides/build/design/implementation-guide.md"), "utf8");
const pages = { architecture, guide, label: "fresh" };

function homeEnv(dir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "x-home-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "x-out-"));
  return {
    home,
    out,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      EXPRESS_REVIEW_NO_OPEN: "1",
      EXPRESS_DEVELOP_OUT: out,
      EXPRESS_REVIEW_OUT: out,
      EXPRESS_DEVELOP_SCAFFOLD: "fixture",
      EXPRESS_DEVELOP_KEEP_CACHE: "1"
    },
    dir
  };
}

test("X2 a document brief is classified from the sentence it needs", () => {
  const heading = classifyFeature("Add a styled heading and an image to the document", pages);
  assert.equal(heading.class, "sandbox");
  assert.ok(architecture.includes(heading.evidence), heading.evidence);
  assert.match(heading.evidence, /createText|text, images|document sandbox/i);
  assert.doesNotMatch(heading.evidence, /^iframe runtime - Your add-on's user interface environment/);

  const oauth = classifyFeature("Connect Dropbox with OAuth and clientStorage", pages);
  assert.equal(oauth.class, "iframe");
  assert.ok(architecture.includes(oauth.evidence), oauth.evidence);
  assert.match(oauth.evidence, /OAuth/);
  assert.doesNotMatch(oauth.evidence, /user interface environment/);
});

test("X3 a template is recommended for a stated reason", () => {
  const ids = ["javascript", "swc-javascript", "javascript-with-document-sandbox", "swc-javascript-with-document-sandbox"];
  const text = recommendTemplate(ids, "Add styled text to the document");
  assert.equal(text.id, "javascript-with-document-sandbox");
  assert.match(text.reason, /document sandbox/);
  assert.doesNotMatch(text.reason, /First name in the list/);
  const form = recommendTemplate(ids, "Add a Spectrum panel with a form");
  assert.equal(form.id, "swc-javascript");
  assert.match(form.reason, /Spectrum/);
  const missing = recommendTemplate(["javascript"], "Add styled text to the document");
  assert.equal(missing.id, "javascript");
  assert.ok(ids.includes(text.id) || missing.id === "javascript");
});

test("X4 a failed audit is named in the summary", () => {
  const session = {
    mode: "chat",
    steps: [
      { id: "docs", status: "done" }, { id: "origin", status: "done" }, { id: "template", status: "skipped" },
      { id: "feasibility", status: "done" }, { id: "design", status: "done" }, { id: "implement", status: "done" },
      { id: "build", status: "done" }, { id: "package", status: "done" }, { id: "audit", status: "done" },
      { id: "express", status: "skipped" }, { id: "listing", status: "skipped" }, { id: "done", status: "pending" }
    ],
    asks: [],
    develop: { auditOk: false, expressPass: false }
  };
  const finished = developNext({ ...session, steps: session.steps.map((step) => step.id === "done" ? { ...step, status: "done" } : step) });
  assert.match(finished.say, /audit failed/i);
  assert.match(finished.say, /was skipped/);
  const probe = fs.readFileSync(path.join(reviewSkill, "assets/audit/probe.js"), "utf8");
  assert.match(probe, /function readableText/);
  assert.match(probe, /shadowRoot/);
  const audit = fs.readFileSync(path.join(reviewSkill, "scripts/lib/audit.mjs"), "utf8");
  const cli = fs.readFileSync(path.join(reviewSkill, "scripts/audit.mjs"), "utf8");
  assert.match(cli, /consoleFindings/);
  assert.match(audit, /key: "script-error"[\s\S]{0,180}severity: "error"/);
  assert.match(audit, /key: "status-error"[\s\S]{0,220}severity: "error"/);
});

test("X5 the server starts before the certificate is trusted", async () => {
  const order = [];
  const ready = await openDevServer({
    cwd: "/tmp/addon",
    timeoutMs: 1000,
    sleep: async () => {},
    spawnImpl() {
      order.push("start");
      return { pid: 9, unref() {} };
    },
    caReady() {
      order.push("ca");
      return true;
    },
    trust() {
      order.push("trust");
      return { ok: true };
    },
    check: async () => {
      order.push("check");
      return { trusted: true };
    },
    identify: async () => {
      order.push("identify");
      return { ok: true, name: "Color Note e" };
    }
  });
  assert.equal(ready.trusted, true);
  assert.deepEqual(order, ["start", "ca", "trust", "check", "identify"]);
  let trusted = false;
  const waiting = await openDevServer({
    cwd: "/tmp/addon",
    timeoutMs: 0,
    sleep: async () => {},
    spawnImpl: () => ({ pid: 4, unref() {} }),
    caReady: () => false,
    trust: () => {
      trusted = true;
      return { ok: true };
    }
  });
  assert.equal(trusted, false);
  assert.match(waiting.error, /did not create the dev CA/);
});

test("X6 a different add-on on port 5241 is not called ready", async () => {
  const wrong = await waitForDevServer({
    cwd: "/tmp/addon",
    timeoutMs: 0,
    sleep: async () => {},
    spawnImpl: () => ({ pid: 5, unref() {} }),
    check: async () => ({ trusted: true }),
    identify: async () => ({ ok: false, error: "https://localhost:5241 is not this add-on. The listing does not contain “Color Note e”." })
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.outcome, "wrong-server");
  assert.match(wrong.error, /not this add-on/);
});

test("X7 a hung doc fetch still lets the process exit", { timeout: 15000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-docs-"));
  const { env, out } = homeEnv(dir);
  assert.equal(run(developCli, ["begin", "--dir", dir, "--empty", "--name", "Docs", "--brief", "caption", "--out", out], env).status, 0);
  assert.equal(run(sessionCli, ["mode", "--set", "chat", "--out", out], env).status, 0);
  const started = Date.now();
  const docs = run(developCli, ["docs", "--budget", "400", "--page-timeout", "200", "--out", out], env, [path.join(root, "test/hang-socket.mjs")]);
  assert.ok(Date.now() - started < 5000, "the hung fetch kept the process alive");
  assert.equal(docs.status, 0, docs.stdout + docs.stderr);
});

test("X8 moving the pointer does not kill the previous dashboard", () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "x-a-"));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), "x-b-"));
  const { env, home } = homeEnv(first);
  const firstOut = fs.mkdtempSync(path.join(os.tmpdir(), "x-out-a-"));
  const secondOut = fs.mkdtempSync(path.join(os.tmpdir(), "x-out-b-"));
  assert.equal(run(developCli, ["begin", "--dir", first, "--empty", "--name", "One", "--brief", "caption", "--out", firstOut], env).status, 0);
  const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  const pid = sleeper.pid;
  fs.writeFileSync(path.join(firstOut, "server.json"), `${JSON.stringify({ pid, port: 1, token: "t" })}\n`);
  assert.equal(run(developCli, ["begin", "--dir", second, "--empty", "--name", "Two", "--brief", "caption", "--out", secondOut], env).status, 0);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  assert.equal(alive, true);
  assert.equal(fs.existsSync(path.join(firstOut, "server.json")), true);
  const pointer = JSON.parse(fs.readFileSync(path.join(home, ".express-addon-develop", "current.json"), "utf8"));
  assert.equal(pointer.out, secondOut);
});

test("X9 --name is written to the manifest", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addon-e-"));
  const { env, out } = homeEnv(dir);
  assert.equal(run(developCli, ["begin", "--dir", dir, "--empty", "--name", "Color Note e", "--brief", "Add a caption field to the panel", "--out", out], env).status, 0);
  assert.equal(run(sessionCli, ["mode", "--set", "chat", "--out", out], env).status, 0);
  assert.equal(run(developCli, ["docs", "--out", out], env, [preloadFixtures]).status, 0);
  assert.equal(run(developCli, ["templates", "--out", out], env, [preloadFixtures]).status, 0);
  assert.equal(run(developCli, ["classify", "--out", out], env).status, 0);
  for (const [id, value] of [["origin", "new"], ["template", "javascript"], ["feasibility", "iframe"], ["design", "leave"], ["implement", "write"]]) {
    assert.equal(run(sessionCli, ["ask", "--id", id, "--out", out], env).status, 0);
    assert.equal(run(sessionCli, ["answer", "--id", id, "--value", value, "--out", out], env).status, 0);
  }
  const handed = run(developCli, ["implement", "--out", out], env);
  assert.equal(handed.status, 0, handed.stdout + handed.stderr);
  assert.equal(handed.json.awaitingAgent, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "src/manifest.json"), "utf8"));
  assert.equal(manifest.name, "Color Note e");
});

test("X10 listing pages quote the add-on, and a failed render is not done", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-list-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body><h1>Color notes</h1><p>Save a caption on the selection.</p></body></html>\n");
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({ name: "Color notes" })}\n`);
  const listing = fs.mkdtempSync(path.join(os.tmpdir(), "x-listing-"));
  const prepared = spawnSync(process.execPath, [path.join(reviewSkill, "scripts/prepare-listing.mjs"), "--out", listing], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const filled = fillListingDir(listing, dir, { shotsDir: capturedShots(640, 1280) });
  assert.equal(filled.ok, true, filled.error);
  const css = fs.readFileSync(path.join(listing, "listing-shot.css"), "utf8");
  for (const name of ["01-cover.html", "02-feature.html", "03-path.html"]) {
    const html = fs.readFileSync(path.join(listing, name), "utf8");
    const problems = lintPage({ html, css, templateCss: css, dir: listing });
    assert.deepEqual(problems, [], `${name}: ${problems.join(" ")}`);
    assert.deepEqual(unquotedPhrases(html, addonCorpus(dir)), [], name);
    assert.doesNotMatch(html, /short phrase from the ui|star\.png/i);
    if (html.includes("panel-front.png")) assert.equal(fs.existsSync(path.join(listing, "panel-front.png")), true);
  }
  const next = developNext({
    mode: "chat",
    steps: [{ id: "listing", status: "pending" }, { id: "done", status: "pending" }],
    asks: [{ id: "listing", status: "answered", answer: "shots" }],
    shots: [],
    develop: { listingShots: "failed" }
  });
  assert.match(next.command, /--status skipped/);
  assert.match(next.say, /not marked done/);
  assert.doesNotMatch(next.command, /--status done/);
});

test("X11 a skipped beta step is not described as a failed pass", () => {
  const session = {
    mode: "chat",
    steps: [
      { id: "express", status: "skipped" },
      { id: "listing", status: "skipped" },
      { id: "done", status: "pending" }
    ],
    asks: [{ id: "express", status: "answered", answer: "skip" }, { id: "listing", status: "answered", answer: "skip" }],
    develop: { expressPass: false }
  };
  const finishing = developNext(session);
  assert.match(finishing.command, /was skipped/);
  assert.doesNotMatch(finishing.command, /did not pass/);
  const app = fs.readFileSync(path.join(reviewSkill, "assets/dashboard/app.js"), "utf8");
  assert.match(app, /was skipped\|did not pass\|audit failed/);
  assert.doesNotMatch(app, /You can also answer in chat/);
});

test("X12 a non-empty folder is refused before a session exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-filled-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
  const { env, home } = homeEnv(dir);
  const refused = run(developCli, ["begin", "--dir", dir, "--name", "Nope", "--brief", "caption"], env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.error, /not an empty folder/);
  assert.match(refused.json.error, /Nothing was deleted/);
  assert.equal(fs.readFileSync(path.join(dir, "notes.txt"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(home, ".express-addon-develop", "nope", "session.json")), false);
});

test("X13 a fresh profile that hangs is killed and the retry can still write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-chrome-"));
  const chrome = path.join(dir, "chrome");
  const out = path.join(dir, "shot.png");
  fs.writeFileSync(chrome, "#!/bin/sh\nprofile=0\nshot=\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    --user-data-dir=*) profile=1 ;;\n    --screenshot=*) shot=${arg#--screenshot=} ;;\n  esac\ndone\nif [ \"$profile\" = 1 ]; then sleep 30; exit 0; fi\nprintf x > \"$shot\"\n");
  fs.chmodSync(chrome, 0o755);
  const started = Date.now();
  shoot({ chrome, url: "about:blank", out, width: 32, height: 32, timeout: 700 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(fs.readFileSync(out, "utf8"), "x");
});

test("X14 the installed cache is left alone, temp dirs are removed, and the session path matches the skill", async () => {
  const watched = path.join(reviewSkill, "references/live/src/pages/guides/learn/platform-concepts/architecture.md");
  const before = fs.statSync(watched).mtimeMs;
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "x-docs-dest-"));
  const previous = process.env.EXPRESS_DEVELOP_WRITE_CACHE;
  delete process.env.EXPRESS_DEVELOP_WRITE_CACHE;
  try {
    const result = await fetchDevDocs({
      pages: ["src/pages/guides/learn/platform-concepts/architecture.md"],
      cacheDir: path.join(reviewSkill, "references/live"),
      destDir: dest,
      fetchImpl: async () => ({ ok: true, text: async () => "rewritten sentence that must not land in the skill" })
    });
    assert.equal(result.counts.fresh, 1);
  } finally {
    if (previous === undefined) delete process.env.EXPRESS_DEVELOP_WRITE_CACHE;
    else process.env.EXPRESS_DEVELOP_WRITE_CACHE = previous;
  }
  assert.equal(fs.statSync(watched).mtimeMs, before);
  assert.equal(fs.readFileSync(watched, "utf8"), architecture);
  assert.match(fs.readFileSync(path.join(dest, "src/pages/guides/learn/platform-concepts/architecture.md"), "utf8"), /rewritten sentence/);

  const source = fs.mkdtempSync(path.join(os.tmpdir(), "x-standin-"));
  fs.writeFileSync(path.join(source, "index.html"), "<!doctype html><html><body>Hi</body></html>\n");
  const served = await serveWithStandIn(source);
  const temp = served.root;
  assert.equal(fs.existsSync(temp), true);
  await served.close();
  assert.equal(fs.existsSync(temp), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x-session-"));
  const { env, home } = homeEnv(dir);
  const began = run(developCli, ["begin", "--dir", dir, "--empty", "--name", "Color Note e", "--brief", "caption"], env);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  const sessionDir = path.join(home, ".express-addon-develop", "color-note-e");
  assert.equal(fs.existsSync(path.join(sessionDir, "session.json")), true);
  assert.equal(fs.existsSync(path.join(path.dirname(dir), ".develop-color-note-e")), false);
  const skill = fs.readFileSync(path.join(root, ".claude/skills/express-addon-develop/SKILL.md"), "utf8");
  assert.match(skill, /~\/\.express-addon-develop\/<slug>/);
});

test("UX the install line names the private repository and the files card changes after a write", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "skill.json"), "utf8"));
  assert.match(readme, /ThisIsMrAli\/addon-developer-assistant/);
  assert.match(readme, /private/i);
  assert.match(readme, /develop beta step can open Express/);
  assert.doesNotMatch(readme, /<owner>\/express-addon-review/);
  assert.match(manifest.install, /ThisIsMrAli\/addon-developer-assistant/);
  assert.doesNotMatch(manifest.install, /<owner>/);
  const app = fs.readFileSync(path.join(reviewSkill, "assets/dashboard/app.js"), "utf8");
  assert.match(app, /Verified and recorded/);
  assert.match(app, /captures\. SDK stand-in/);
  assert.match(app, /s\?\.kind === "develop"\) return steps\(\)/);
  const wait = fs.readFileSync(path.join(reviewSkill, "scripts/session.mjs"), "utf8");
  assert.match(wait, /Start it with `node scripts\/dashboard\.mjs start`/);
  assert.match(wait, /AskQuestion/);
});
