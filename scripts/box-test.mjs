#!/usr/bin/env node
/**
 * Tests that do not need a browser and do not scaffold a real add-on.
 * Chrome and Edge stay closed unless BOX_TEST_BROWSER=1.
 * Run from the repository root: `node scripts/box-test.mjs`
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickEngine } from "../.claude/skills/express-addon-review/scripts/lib/fit.mjs";

// `node --test` also loads this file, because the name ends in test.mjs. That copy must not start another run.
if (process.env.NODE_TEST_CONTEXT) process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const optIn = process.env.BOX_TEST_BROWSER === "1";
const browserReason = "The box runner does not start Chrome or Edge. Set BOX_TEST_BROWSER=1 to run it.";
const scaffoldReason = "The box runner does not scaffold a live add-on or start Chrome. Set BOX_TEST_BROWSER=1 only opts into browser tests; this end-to-end run stays off.";

const skips = [];
if (!optIn) {
  if (pickEngine() === "chrome") {
    skips.push(["a wide capture is fitted to 1360x800", browserReason]);
  }
  skips.push(["render-listing makes a 1360x800 PNG with the chrome fit", browserReason]);
  for (const name of [
    "the probe finds each class of bug on its page, and nothing on a good one",
    "the close button at the bottom of a dialog is an error that says where it is and how to fix it",
    "the audit walks a real panel: finds both dialogs' bugs, never presses Delete, and confirms a fix on the next run",
    "when nothing answers and there is no start script, the audit says what to do and keeps the review going",
    "a second audit in the same review is refused while the first still runs, and a dead lock is ignored",
    "a welcome tour is stepped through for free, and the panel behind it is walked"
  ]) {
    skips.push([name, browserReason]);
  }
}
skips.push(["an empty folder becomes a real template that builds, packages, and passes the audit with a stand-in", scaffoldReason]);

for (const [name, reason] of skips) {
  process.stdout.write(`skip: ${name} — ${reason}\n`);
}

const env = { ...process.env, SKIP_E2E: "1" };
if (optIn) delete env.SKIP_BROWSER_TESTS;
else env.SKIP_BROWSER_TESTS = "1";

const result = spawnSync(process.execPath, ["--test", "--test-skip-pattern", "box-test"], {
  cwd: root,
  stdio: "inherit",
  env
});
process.exit(result.status ?? 1);
