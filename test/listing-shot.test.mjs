import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { png } from "./helpers.mjs";
import { findChrome, shoot } from "../.claude/skills/express-addon-review/scripts/lib/chrome.mjs";
import { pickEngine } from "../.claude/skills/express-addon-review/scripts/lib/fit.mjs";
import { imageSize } from "../.claude/skills/express-addon-review/scripts/lib/images.mjs";

const launchesChrome = pickEngine() === "chrome";
const fitSkip = launchesChrome && process.env.SKIP_BROWSER_TESTS
  ? "The box runner does not start Chrome or Edge. Set BOX_TEST_BROWSER=1 to run it."
  : launchesChrome && !findChrome()
    ? "No Chrome, Edge, or Chromium was found."
    : false;

test("a wide capture is fitted to 1360x800", { skip: fitSkip, timeout: 30_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-shot-"));
  const input = path.join(dir, "raw.png");
  const out = path.join(dir, "01-cover.png");
  fs.writeFileSync(input, png(400, 300));
  const result = spawnSync(process.execPath, [path.resolve(".claude/skills/express-addon-review/scripts/fit-listing-shot.mjs"), "--input", input, "--out", out], { encoding: "utf8", timeout: 25_000 });
  if (result.error?.code === "ETIMEDOUT") {
    assert.fail("Chrome did not finish the listing fit within 25s, so it cannot run here.");
  }
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(imageSize(fs.readFileSync(out)), { width: 1360, height: 800 });
});

test("a Chrome that does not finish fails in seconds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-shot-hang-"));
  const chrome = path.join(dir, process.platform === "win32" ? "chrome.cmd" : "chrome");
  if (process.platform === "win32") fs.writeFileSync(chrome, "@ping -n 30 127.0.0.1 >nul\r\n");
  else {
    fs.writeFileSync(chrome, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(chrome, 0o755);
  }
  const out = path.join(dir, "01-cover.png");
  const started = Date.now();
  assert.throws(
    () => shoot({ chrome, url: "about:blank", out, width: 32, height: 32, timeout: 800 }),
    /cannot run here/
  );
  assert.ok(Date.now() - started < 5_000, "a Chrome that hangs must not wait the old 60s");
  assert.equal(fs.existsSync(out), false);
});

test("a capture that is too short is rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-shot-"));
  const input = path.join(dir, "raw.png");
  const out = path.join(dir, "01-cover.png");
  fs.writeFileSync(input, png(1360, 100));
  const result = spawnSync(process.execPath, [path.resolve(".claude/skills/express-addon-review/scripts/fit-listing-shot.mjs"), "--input", input, "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /shorter than 800/);
});
