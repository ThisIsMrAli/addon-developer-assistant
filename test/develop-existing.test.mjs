import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readZip } from "../.claude/skills/express-addon-review/scripts/lib/package.mjs";
import { manifest, project } from "./helpers.mjs";
import { blockFetch, developCli, run, sessionCli } from "./drive-develop.mjs";

test("an existing add-on is not edited before the gate, then gains a caption and a zip", () => {
  const dir = project({
    "index.html": "<!doctype html><html><body><h1>Already here</h1></body></html>\n",
    "package.json": { name: "already", private: true },
    "manifest.json": { ...manifest, testId: "11111111-1111-4111-8111-111111111111" }
  });
  const htmlPath = path.join(dir, "index.html");
  const before = fs.readFileSync(htmlPath, "utf8");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "develop-out-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "develop-home-"));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EXPRESS_REVIEW_NO_OPEN: "1",
    EXPRESS_REVIEW_OUT: out,
    EXPRESS_DEVELOP_OUT: out,
    EXPRESS_DEVELOP_KEEP_CACHE: "1"
  };

  assert.equal(run(developCli, ["begin", "--dir", dir, "--name", "Already", "--brief", "Add a caption field to the panel", "--out", out], env, [blockFetch]).status, 0);
  const early = run(developCli, ["implement", "--out", out], env);
  assert.notEqual(early.status, 0);
  assert.match(early.json.error, /Refusing to write/);
  assert.equal(fs.readFileSync(htmlPath, "utf8"), before);

  assert.equal(run(sessionCli, ["mode", "--set", "chat", "--out", out], env).status, 0);
  const docs = run(developCli, ["docs", "--out", out], env, [blockFetch]);
  assert.equal(docs.status, 0, docs.stdout + docs.stderr);
  assert.equal(docs.json.counts.stale, 6);
  assert.equal(docs.json.counts.fresh, 0);
  const classified = run(developCli, ["classify", "--out", out], env);
  assert.equal(classified.status, 0, classified.stdout + classified.stderr);
  assert.equal(classified.json.class, "iframe");
  assert.equal(classified.json.docsLabel, "stale");

  const still = run(developCli, ["implement", "--out", out], env);
  assert.notEqual(still.status, 0);
  assert.equal(fs.readFileSync(htmlPath, "utf8"), before);

  answer(env, out, "plan", "build");
  answer(env, out, "design", "leave");
  const wrote = run(developCli, ["implement", "--out", out], env);
  assert.equal(wrote.status, 0, wrote.stdout + wrote.stderr);
  assert.equal(wrote.json.awaitingAgent, true);
  assert.equal(fs.readFileSync(htmlPath, "utf8"), before);
  const html = before.includes("</body>")
    ? before.replace("</body>", `<label for="caption-field">Caption</label>\n<input id="caption-field" name="caption" type="text" />\n</body>`)
    : `${before}\n<label for="caption-field">Caption</label>\n`;
  fs.writeFileSync(htmlPath, html);
  const recorded = run(developCli, ["record", "--out", out], env);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  assert.match(fs.readFileSync(htmlPath, "utf8"), /caption-field/);
  assert.doesNotMatch(fs.readFileSync(htmlPath, "utf8"), /develop-feature/);

  assert.equal(run(developCli, ["build", "--out", out], env).status, 0);
  const packed = run(developCli, ["package", "--out", out], env);
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const zip = readZip(packed.json.zip);
  assert.ok(zip.entries.some((entry) => entry.name === "manifest.json"));
  assert.match(zip.read("index.html"), /caption-field/);
});

function answer(env, out, id, value) {
  const ask = run(sessionCli, ["ask", "--id", id, "--out", out], env);
  assert.equal(ask.status, 0, ask.stdout + ask.stderr);
  const answered = run(sessionCli, ["answer", "--id", id, "--value", value, "--out", out], env);
  assert.equal(answered.status, 0, answered.stdout + answered.stderr);
}
