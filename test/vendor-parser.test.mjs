import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVendoredParser } from "../.claude/skills/express-addon-develop/scripts/lib/code-scan.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const developSkill = path.join(root, ".claude/skills/express-addon-develop");
const reviewSkill = path.join(root, ".claude/skills/express-addon-review");

const manifest = `${JSON.stringify({
  name: "Sample",
  testId: "11111111-1111-4111-8111-111111111111",
  version: "1.0.0",
  manifestVersion: 2,
  requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
  entryPoints: [{ type: "panel", id: "panel1", main: "index.html", documentSandbox: "code.js" }]
}, null, 2)}\n`;

function copySkills(dest) {
  fs.cpSync(developSkill, path.join(dest, "express-addon-develop"), { recursive: true, dereference: true });
  fs.cpSync(reviewSkill, path.join(dest, "express-addon-review"), { recursive: true, dereference: true });
  fs.rmSync(path.join(dest, "express-addon-develop/node_modules"), { recursive: true, force: true });
  fs.rmSync(path.join(dest, "express-addon-review/node_modules"), { recursive: true, force: true });
}

test("a missing vendored parser is a hard stop", () => {
  assert.throws(() => loadVendoredParser(path.join(os.tmpdir(), "no-such-babel-parser.js")), /vendored @babel\/parser is missing/);
});

test("a fresh skill copy with no node_modules parses decorators and accepts styled text", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-copy-"));
  const temp = path.join(dest, "tmp");
  fs.mkdirSync(temp);
  copySkills(dest);
  const script = `
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkJsSyntax } from "./express-addon-develop/scripts/lib/code-scan.mjs";
import { TEXT_INSIDE_PAGE, verifyFeature } from "./express-addon-develop/scripts/lib/implement.mjs";
const file = path.join(os.tmpdir(), "decorator-src.js");
fs.writeFileSync(file, "@customElement(\\"add-on-root\\")\\nclass Panel {}\\nconst label: string = \\"Hi\\";\\n");
const syntax = checkJsSyntax(file);
if (syntax) throw new Error(syntax);
if (/not installed/.test(syntax)) throw new Error(syntax);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-addon-"));
fs.writeFileSync(path.join(dir, "manifest.json"), ${JSON.stringify(manifest)});
fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body><button>Add heading</button></body></html>\\n");
fs.writeFileSync(path.join(dir, "code.js"), TEXT_INSIDE_PAGE);
const result = verifyFeature({ dir, brief: "Add styled text to the document", build: false });
if (!result.ok) throw new Error(result.problems.join(" "));
if (/not installed/.test(result.problems.join(" "))) throw new Error(result.problems.join(" "));
console.log("vendor-ok");
`;
  fs.writeFileSync(path.join(dest, "check.mjs"), script);
  const ran = spawnSync(process.execPath, ["check.mjs"], {
    cwd: dest,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NODE_PATH: "", TMPDIR: temp, npm_config_update_notifier: "false" }
  });
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  assert.match(ran.stdout, /vendor-ok/);
});

test("npx skills add installs a parser that works with no node_modules", { timeout: 180_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "skills-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "skills-cwd-"));
  const ran = spawnSync("npx", [
    "--yes", "skills@1.7.6", "add", root,
    "--skill", "express-addon-develop",
    "--skill", "express-addon-review",
    "-g", "-a", "claude-code", "-y", "--copy"
  ], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, HOME: home, TMPDIR: home, NODE_PATH: "", npm_config_update_notifier: "false" }
  });
  assert.equal(ran.status, 0, `${ran.stdout}\n${ran.stderr}`);
  const installed = path.join(home, ".claude/skills/express-addon-develop");
  const parserFile = path.join(installed, "vendor/babel-parser/lib/index.js");
  assert.equal(fs.existsSync(parserFile), true, ran.stdout);
  assert.equal(fs.lstatSync(parserFile).isSymbolicLink(), false);
  assert.match(fs.readFileSync(path.join(installed, "vendor/babel-parser/LICENSE"), "utf8"), /Permission is hereby granted/);
  const check = path.join(cwd, "installed-check.mjs");
  fs.writeFileSync(check, `
import { checkJsSyntax } from ${JSON.stringify(path.join(installed, "scripts/lib/code-scan.mjs"))};
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const file = path.join(os.tmpdir(), "installed-decorator.js");
fs.writeFileSync(file, "@customElement(\\"add-on-root\\")\\nclass Panel {}\\n");
const syntax = checkJsSyntax(file);
if (syntax) throw new Error(syntax);
console.log("installed-ok");
`);
  const parsed = spawnSync(process.execPath, [check], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: home, TMPDIR: home, NODE_PATH: "" }
  });
  assert.equal(parsed.status, 0, `${parsed.stdout}\n${parsed.stderr}`);
  assert.match(parsed.stdout, /installed-ok/);
});
