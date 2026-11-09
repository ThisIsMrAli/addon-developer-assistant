import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findChrome } from "../.claude/skills/express-addon-review/scripts/lib/chrome.mjs";
import { readZip } from "../.claude/skills/express-addon-review/scripts/lib/package.mjs";
import { readMerged } from "../.claude/skills/express-addon-review/scripts/lib/session.mjs";
import { developCli, drive, run } from "./drive-develop.mjs";

const skip = process.env.SKIP_E2E
  ? "The box runner does not scaffold a live add-on or start Chrome. Set BOX_TEST_BROWSER=1 only opts into browser tests; this end-to-end run stays off."
  : process.env.SKIP_BROWSER_TESTS
    ? "The box runner does not start Chrome or Edge. Set BOX_TEST_BROWSER=1 to run it."
    : !findChrome()
      ? "No Chrome, Edge, or Chromium was found."
      : false;

test("an empty folder becomes a real template that builds, packages, and passes the audit with a stand-in", { skip, timeout: 900000 }, () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "develop-addon-"));
  const dir = path.join(parent, "caption-addon");
  fs.mkdirSync(dir);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "develop-home-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    npm_config_yes: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    EXPRESS_REVIEW_NO_OPEN: "1",
    EXPRESS_REVIEW_OUT: out,
    EXPRESS_DEVELOP_OUT: out
  };
  const began = run(developCli, ["begin", "--dir", dir, "--name", "Caption", "--brief", "Add a caption field to the panel", "--out", out], env);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  const walked = drive(out, env, { audit: "run" });
  assert.ok(walked.asked.includes("template"));
  assert.equal(walked.asked.at(-2), "express");
  assert.equal(walked.asked.at(-1), "listing");

  const session = readMerged(out);
  assert.equal(session.develop.expressPass, false);
  assert.equal(session.develop.standIn, "express-sdk-stand-in");
  assert.equal(session.develop.expressHostRan, false);
  assert.deepEqual(session.develop.auditBugs, []);
  const browser = JSON.parse(fs.readFileSync(path.join(out, "browser-run.json"), "utf8"));
  assert.equal(browser.expressPass, false);
  assert.equal(browser.standIn, "express-sdk-stand-in");
  assert.match(browser.note, /not an Adobe Express pass/);
  assert.equal(browser.audit.bugs.length, 0);
  assert.ok(browser.audit.screens > 0);
  assert.equal((browser.audit.bugs || []).some((bug) => bug.kind === "panel-blank"), false);
  const zip = readZip(session.develop.zip);
  assert.ok(zip.entries.some((entry) => entry.name === "manifest.json"), zip.entries.map((entry) => entry.name).join(", "));
  const html = fs.readFileSync(path.join(dir, "src/index.html"), "utf8");
  assert.match(html, /caption-field/);
  assert.doesNotMatch(html, /develop-feature|function featureReady/);
  console.log(`e2e template=${session.asks.find((item) => item.id === "template")?.answer} bugs=${browser.audit.bugs.length} screens=${browser.audit.screens}`);
});
