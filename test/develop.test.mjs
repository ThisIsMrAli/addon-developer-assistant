import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDevDocs } from "../.claude/skills/express-addon-develop/scripts/lib/docs-live.mjs";
import { classifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/feasibility.mjs";
import { gate } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { parseTemplateIds } from "../.claude/skills/express-addon-develop/scripts/lib/templates.mjs";
import { fetchTemplates } from "../.claude/skills/express-addon-develop/scripts/lib/templates.mjs";
import { readSession } from "../.claude/skills/express-addon-review/scripts/lib/session.mjs";
import { project } from "./helpers.mjs";
import {
  blockFetch, dashboardCli, developCli, developSkill, drive, preloadFixtures, reviewCli, reviewSkill, run, sessionCli, setupCli
} from "./drive-develop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TIMES = path.join(root, "measurements.json");

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

function emptyDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "develop-empty-"));
}

test("begin makes no network call, and mode is the first action", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out);
  const began = run(developCli, ["begin", "--dir", emptyDir(), "--name", "Offline", "--brief", "Add a caption field", "--out", out], env, [blockFetch]);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  assert.equal(began.json.ok, true);
  assert.equal(began.json.network, false);
  assert.doesNotMatch(`${began.stdout}\n${began.stderr}`, /network called/);
  const session = readSession(out);
  assert.equal(session.kind, "develop");
  assert.equal(session.mode, null);
  assert.equal(session.docs, null);
  const ids = session.steps.map((step) => step.id);
  assert.deepEqual(ids, ["docs", "origin", "template", "feasibility", "design", "implement", "build", "package", "audit", "express", "listing", "done"]);
  const next = run(sessionCli, ["next", "--out", out], env);
  assert.equal(next.json.action, "ask-mode");
  assert.equal(next.json.command, undefined);
  assert.match(next.json.say, /AskQuestion/);
  assert.match(next.json.say, /Do not fetch/);
});

test("the Express step is immediately before listing, and skip goes straight to the listing and screenshots", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out, { EXPRESS_DEVELOP_SCAFFOLD: "fixture" });
  const began = run(developCli, ["begin", "--dir", emptyDir(), "--name", "Order", "--brief", "Add a caption field to the panel", "--out", out], env, [blockFetch]);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  const session = readSession(out);
  const steps = session.steps.map((step) => step.id);
  const express = session.steps.find((step) => step.id === "express");
  assert.equal(steps.indexOf("express"), steps.indexOf("listing") - 1);
  assert.equal(express.optional, true);
  const questions = JSON.parse(fs.readFileSync(path.join(out, "questions.json"), "utf8"));
  const expressAsk = questions.find((item) => item.id === "express");
  assert.equal(questions.map((item) => item.id).indexOf("express"), questions.map((item) => item.id).indexOf("listing") - 1);
  assert.match(expressAsk.prompt, /Run a real test in Adobe Express \(beta\)\?/);
  assert.equal(expressAsk.options[0].id, "skip");
  assert.match(expressAsk.options[0].label, /Recommended/);
  assert.match(expressAsk.options[0].detail, /listing/i);
  assert.equal(expressAsk.options[1].id, "run");
  assert.match(questions.find((item) => item.id === "listing").prompt, /screenshot/i);

  const walked = drive(out, env, { imports: [preloadFixtures], audit: "skip" });
  assert.deepEqual(walked.asked, ["origin", "template", "feasibility", "design", "implement", "express", "listing"]);
  const expressAt = walked.actions.indexOf("ask-in-chat:express");
  assert.equal(walked.actions[expressAt + 1], "ask-in-chat:listing");
  assert.equal(walked.actions[0], "ask-mode");
  const docsAt = walked.actions.indexOf("run");
  assert.ok(docsAt > 0, "docs run after mode");
  const finished = readSession(out);
  assert.equal(finished.steps.find((step) => step.id === "express").status, "skipped");
  assert.equal(finished.develop.expressPass, false);
  assert.equal(finished.develop.standIn, "express-sdk-stand-in");
  const html = fs.readFileSync(path.join(finished.addon.path, "src/index.html"), "utf8");
  assert.match(html, /id="caption-field"/);
  assert.match(html, /Caption/);
  assert.doesNotMatch(html, /develop-feature|featureReady/);
});

test("dashboard mode asks on the dashboard, and a stopped server falls back to AskQuestion", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out);
  const began = run(developCli, ["begin", "--dir", emptyDir(), "--name", "Dash", "--brief", "Add a caption field", "--out", out], env, [blockFetch]);
  assert.equal(began.status, 0, began.stdout);
  assert.equal(run(sessionCli, ["mode", "--set", "dashboard", "--out", out], env).status, 0);
  const started = run(dashboardCli, ["start", "--out", out, "--no-open"], env);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  try {
    const ask = run(sessionCli, ["ask", "--id", "origin", "--out", out], env);
    assert.equal(ask.status, 0, ask.stdout + ask.stderr);
    assert.equal(ask.json.channel, "dashboard");
    assert.doesNotMatch(ask.stdout, /AskQuestion/);
    assert.match(ask.stdout, /wait/);
    assert.match(ask.json.next, /Do NOT write a message to the user/);
  } finally {
    run(dashboardCli, ["stop", "--out", out], env);
  }
  const waited = run(sessionCli, ["wait", "--id", "origin", "--timeout", "1", "--out", out], env);
  assert.equal(waited.json.status, "server-down");
  assert.match(waited.stdout, /AskQuestion/);
});

test("time-to-dashboard is measured the same way for Preflight and for the assistant", async () => {
  const reference = await untilDashboard("reference");
  const assistant = await untilDashboard("assistant");
  const record = {
    method: "Wall clock from the session-opening command (review.mjs --no-refresh, or develop begin with fetch blocked) through mode --set dashboard and dashboard start --no-open, until GET of the printed loopback URL returns 200. EXPRESS_REVIEW_NO_OPEN=1. HOME is a temp directory.",
    referenceMs: Math.round(reference.ms),
    assistantMs: Math.round(assistant.ms),
    thresholdMs: 4000
  };
  fs.writeFileSync(TIMES, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`time-to-dashboard reference_ms=${record.referenceMs} assistant_ms=${record.assistantMs}`);
  assert.ok(record.referenceMs < 4000, `reference took ${record.referenceMs}ms`);
  assert.ok(record.assistantMs < 4000, `assistant took ${record.assistantMs}ms`);
  assert.equal(assistant.expressBeforeListing, true);
  assert.match(assistant.appJs, /BETA/);
});

test("doc pages are labelled fresh, stale, or failed", async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "develop-cache-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "develop-docs-"));
  fs.mkdirSync(path.join(cache, "kept"), { recursive: true });
  fs.writeFileSync(path.join(cache, "kept/page.md"), "cached sentence");
  const result = await fetchDevDocs({
    pages: ["fresh/page.md", "kept/page.md", "missing/page.md"],
    cacheDir: cache,
    destDir: dest,
    budgetMs: 5000,
    pageMs: 2000,
    fetchImpl: async (url) => {
      if (String(url).endsWith("fresh/page.md")) return { ok: true, text: async () => "live sentence" };
      throw new Error("down");
    }
  });
  assert.equal(result.counts.fresh, 1);
  assert.equal(result.counts.stale, 1);
  assert.equal(result.counts.failed, 1);
  assert.deepEqual(result.pages.map((page) => page.label), ["fresh", "stale", "failed"]);
  assert.equal(fs.readFileSync(path.join(dest, "kept/page.md"), "utf8"), "cached sentence");
});

test("a feature is classified only from a sentence the page contains", () => {
  const architecture = fs.readFileSync(path.join(reviewSkill, "references/live/src/pages/guides/learn/platform-concepts/architecture.md"), "utf8");
  const guide = fs.readFileSync(path.join(reviewSkill, "references/live/src/pages/guides/build/design/implementation-guide.md"), "utf8");
  const pages = { architecture, guide, label: "stale" };
  const ui = classifyFeature("Add a caption field to the panel", pages);
  assert.equal(ui.class, "iframe");
  assert.ok(architecture.includes(ui.evidence), "evidence must be copied from the page");
  assert.equal(ui.docsLabel, "stale");
  const sandbox = classifyFeature("Create a rectangle on the document", pages);
  assert.equal(sandbox.class, "sandbox");
  assert.ok(architecture.includes(sandbox.evidence));
  const blocked = classifyFeature("Call fetch() inside the document sandbox", pages);
  assert.equal(blocked.class, "unsupported");
  assert.ok(architecture.includes(blocked.evidence));
  assert.match(guide, /Spectrum Web Components/);
  const blind = classifyFeature("Add a caption field", { architecture: "", guide: "", label: "failed" });
  assert.equal(blind.class, null);
});

test("template ids are parsed from the fetched source, and the module has no built-in list", () => {
  const source = [
    'export const WITH_DOCUMENT_SANDBOX = "with-document-sandbox";',
    "export const AVAILABLE_ADD_ON_TEMPLATES = [",
    '  "javascript",',
    '  "swc-javascript",',
    "  `javascript-${WITH_DOCUMENT_SANDBOX}`,",
    "];"
  ].join("\n");
  assert.deepEqual(parseTemplateIds(source), ["javascript", "swc-javascript", "javascript-with-document-sandbox"]);
  const moduleSource = fs.readFileSync(path.join(developSkill, "scripts/lib/templates.mjs"), "utf8");
  for (const id of ["swc-typescript-with-document-sandbox", "react-javascript-with-document-sandbox", "react-typescript-with-document-sandbox", "swc-javascript-with-document-sandbox"]) {
    assert.equal(moduleSource.includes(id), false, id);
  }
});

test("a template that was not in the fetch is refused", () => {
  const answered = (id, answer) => ({ id, status: "answered", answer });
  const decision = gate({
    asks: [answered("origin", "new"), answered("template", "not-published"), answered("feasibility", "iframe"), answered("design", "leave"), answered("implement", "write")],
    templates: { ids: ["javascript"] }
  });
  assert.equal(decision.ok, false);
  assert.match(decision.error, /not-published/);
});

test("the Linux setup command does not open Express and does not disable the Chrome flag", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out, { EXPRESS_DEVELOP_SETUP_EXEC: "0" });
  assert.equal(run(developCli, ["begin", "--dir", emptyDir(), "--name", "Sideload", "--brief", "caption", "--out", out], env, [blockFetch]).status, 0);
  const result = run(setupCli, ["--out", out], env);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const record = result.json;
  assert.equal(record.expressHostRan, false);
  assert.equal(record.expressPass, false);
  assert.equal(record.browserRunIsExpressPass, false);
  assert.equal(record.executed, false);
  assert.equal(record.flagState, "leave enabled");
  assert.equal(record.host, "https://localhost:5241");
  assert.equal(record.notHost, "127.0.0.1");
  assert.equal(record.nickname, "adobe-ccweb-devcert");
  assert.equal(record.trust, "C,,");
  assert.match(record.error, /npm run start/);
  const manual = record.manual.join("\n");
  assert.match(manual, /libnss3-tools/);
  assert.match(manual, /certutil/);
  assert.match(manual, /sql:\$HOME\/\.pki\/nssdb/);
  assert.match(manual, /sql:\$HOME\/\.local\/share\/pki\/nssdb/);
  assert.match(manual, /https:\/\/localhost:5241/);
  assert.match(manual, /local-network-access-check/);
  assert.match(manual, /Allow/);
  assert.match(manual, /Add-on Development/);
  assert.match(manual, /In development/);
  assert.match(manual, /did not open Adobe Express/);
  const planned = record.planned.join("\n");
  assert.doesNotMatch(planned, /ignore-certificate/);
  assert.doesNotMatch(planned, /127\.0\.0\.1/);
  assert.doesNotMatch(planned, /disabled/i);
  assert.equal(record.performed.length, 0);
  if (!record.certutilPresent) {
    assert.match(planned, /apt-get/);
    assert.match(planned, /libnss3-tools/);
    assert.equal(record.install.urls.length, 2);
    assert.match(record.install.urls[0], /debian-security\/pool/);
    assert.match(record.install.urls[1], /debian\/pool/);
    for (const url of record.install.urls) assert.doesNotMatch(url, /libnss3-tools_\d+:/);
  }
  const session = readSession(out);
  assert.equal(session.develop.expressHostRan, false);
  assert.equal(session.develop.expressPass, false);
});

test("the live template list is the constants file that was fetched", { skip: process.env.SKIP_E2E ? "skipped with the end-to-end suite" : false }, async () => {
  const result = await fetchTemplates();
  assert.equal(result.ok, true, result.errors?.join("\n") || result.note);
  const parsed = parseTemplateIds(result.raw.constants);
  assert.ok(parsed.length > 0);
  if (result.directory?.length) {
    assert.deepEqual(result.ids, parsed.filter((id) => result.directory.includes(id)));
  } else {
    assert.deepEqual(result.ids, parsed);
  }
  assert.ok(result.ids.includes("javascript"), `fetched ids: ${result.ids.join(", ")}`);
});

async function untilDashboard(kind) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const env = isolatedEnv(out);
  const startedAt = performance.now();
  if (kind === "reference") {
    const addon = project({ "index.html": "<!doctype html><body><p>Hello</p></body>" });
    const review = run(reviewCli, ["--input", addon, "--no-refresh", "--out", out], env, [blockFetch]);
    assert.ok(fs.existsSync(path.join(out, "session.json")), review.stdout + review.stderr);
  } else {
    const began = run(developCli, ["begin", "--dir", emptyDir(), "--name", "Timer", "--brief", "Add a caption field", "--out", out], env, [blockFetch]);
    assert.equal(began.status, 0, began.stdout + began.stderr);
  }
  assert.equal(run(sessionCli, ["mode", "--set", "dashboard", "--out", out], env).status, 0);
  const dash = run(dashboardCli, ["start", "--out", out, "--no-open"], env);
  assert.equal(dash.status, 0, dash.stdout + dash.stderr);
  const info = JSON.parse(dash.stdout);
  const page = new URL(info.url);
  const token = page.searchParams.get("t");
  let appJs = "";
  let expressBeforeListing = false;
  try {
    const response = await fetch(info.url);
    assert.equal(response.status, 200);
    if (kind === "assistant") {
      const stateRes = await fetch(`http://127.0.0.1:${info.port}/api/state?t=${token}`);
      assert.equal(stateRes.status, 200);
      const state = await stateRes.json();
      const steps = state.session.steps.map((step) => step.id);
      expressBeforeListing = steps.indexOf("express") === steps.indexOf("listing") - 1;
      const appRes = await fetch(`http://127.0.0.1:${info.port}/app.js?t=${token}`);
      assert.equal(appRes.status, 200);
      appJs = await appRes.text();
    }
  } finally {
    run(dashboardCli, ["stop", "--out", out], env);
  }
  return { ms: performance.now() - startedAt, expressBeforeListing, appJs };
}
