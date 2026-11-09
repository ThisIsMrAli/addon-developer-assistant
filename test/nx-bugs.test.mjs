import test from "node:test";
import assert from "node:assert/strict";
import { capturedShots } from "./helpers.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/feasibility.mjs";
import { pagesForBrief } from "../.claude/skills/express-addon-develop/scripts/lib/docs-live.mjs";
import { launchSpec, openDevServer, seedChromeProfile } from "../.claude/skills/express-addon-develop/scripts/lib/express-host.mjs";
import { verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { fillListingDir } from "../.claude/skills/express-addon-develop/scripts/lib/listing-copy.mjs";
import { developNext } from "../.claude/skills/express-addon-develop/scripts/lib/flow.mjs";
import { STANDIN_SOURCE, serveWithStandIn } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { prepareDevCa, SSL_WARNING, sudoGuard, SYSTEM_CA } from "../.claude/skills/express-addon-develop/scripts/lib/ssl-setup.mjs";
import { developCli, preloadFixtures, run, sessionCli } from "./drive-develop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewSkill = path.join(root, ".claude/skills/express-addon-review");
const architecture = fs.readFileSync(path.join(reviewSkill, "references/live/src/pages/guides/learn/platform-concepts/architecture.md"), "utf8");

function homeEnv(dir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nx-home-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nx-out-"));
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

test("NX1 the preview server answers while a child process runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx1-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body><button>Add heading</button></body></html>\n");
  const served = await serveWithStandIn(dir);
  const result = await new Promise((resolve) => {
    const child = spawn("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", served.url]);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (status) => resolve({ status, out }));
  });
  await served.close();
  assert.equal(result.out, "200");
});

test("NX2 the stand-in exports the documented SDK surface", () => {
  assert.match(STANDIN_SOURCE, /export const RuntimeType/);
  assert.match(STANDIN_SOURCE, /documentSandbox/);
  assert.match(STANDIN_SOURCE, /authorize/);
  assert.match(STANDIN_SOURCE, /createRenditions/);
  assert.match(STANDIN_SOURCE, /Range/);
  assert.match(STANDIN_SOURCE, /RenditionIntent/);
  assert.match(STANDIN_SOURCE, /clientStorage/);
});

test("NX5 a top-level permissions key is rejected and the entry point key is accepted", () => {
  const brief = "Connect Dropbox with OAuth and clientStorage";
  const html = "<!doctype html><html><body><button>Connect</button></body></html>\n";
  const code = "try { await addOnUISdk.app.oauth.authorize(); await addOnUISdk.instance.clientStorage.setItem('token', token); } catch (error) {}\n";
  const base = {
    name: "Sample", testId: "11111111-1111-4111-8111-111111111111", version: "1.0.0", manifestVersion: 2,
    requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
    entryPoints: [{ type: "panel", id: "panel1", main: "index.html" }]
  };
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "nx5-top-"));
  fs.writeFileSync(path.join(top, "manifest.json"), `${JSON.stringify({ ...base, permissions: { oauth: ["www.dropbox.com"] } }, null, 2)}\n`);
  fs.writeFileSync(path.join(top, "index.html"), html);
  fs.writeFileSync(path.join(top, "index.js"), code);
  const rejected = verifyFeature({ dir: top, brief, build: false });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /entryPoints|top-level/);

  const good = fs.mkdtempSync(path.join(os.tmpdir(), "nx5-good-"));
  fs.writeFileSync(path.join(good, "manifest.json"), `${JSON.stringify({
    ...base,
    entryPoints: [{ type: "panel", id: "panel1", main: "index.html", permissions: { oauth: ["www.dropbox.com"] } }]
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(good, "index.html"), html);
  fs.writeFileSync(path.join(good, "index.js"), code);
  const accepted = verifyFeature({ dir: good, brief, build: false });
  assert.equal(accepted.ok, true, accepted.problems.join(" "));
});

test("NX6 a document-sandbox brief is not classified as iframe", () => {
  const result = classifyFeature("A panel with a Spectrum text field and button that inserts the typed text into the document via the document sandbox", { architecture, guide: "", label: "fresh" });
  assert.equal(result.class, "sandbox");
  assert.ok(architecture.includes(result.evidence), result.evidence);
  assert.match(result.evidence, /document sandbox|createText|text, images/i);
  assert.doesNotMatch(result.evidence, /user interface environment/);
});

test("NX7 the fetched pages follow the brief", () => {
  const text = pagesForBrief("Add a styled heading and an image to the document");
  assert.ok(text.includes("src/pages/guides/learn/how-to/use-text.md"));
  assert.ok(text.includes("src/pages/guides/learn/how-to/use-images.md"));
  const oauth = pagesForBrief("Connect Dropbox with OAuth and clientStorage");
  assert.ok(oauth.includes("src/pages/guides/learn/how-to/oauth2.md"));
  const rendition = pagesForBrief("Export the current page as a PNG rendition and download it");
  assert.ok(rendition.includes("src/pages/guides/learn/how-to/create-renditions.md"));
  assert.equal(pagesForBrief("Add a caption field to the panel").some((id) => /use-text|oauth2|create-renditions/.test(id)), false);
});

test("NX8 a refused begin does not send the agent to review.mjs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx8-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep");
  const { env, home } = homeEnv(dir);
  const refused = run(developCli, ["begin", "--dir", dir, "--name", "Nope", "--brief", "caption"], env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.json.next, /No session was created/);
  assert.match(refused.json.next, /Do not run session\.mjs next/);
  assert.doesNotMatch(refused.json.next, /review\.mjs/);
  const clean = { ...env };
  delete clean.EXPRESS_DEVELOP_OUT;
  delete clean.EXPRESS_REVIEW_OUT;
  const orphan = spawnSync(process.execPath, [path.join(root, ".claude/skills/express-addon-develop/scripts/session.mjs"), "next"], { encoding: "utf8", env: clean });
  assert.notEqual(orphan.status, 0);
  assert.match(orphan.stdout, /No develop session/);
  assert.doesNotMatch(`${orphan.stdout}\n${orphan.stderr}`, /Run review\.mjs first/);
  assert.equal(fs.existsSync(path.join(home, ".express-addon-develop", "nope", "session.json")), false);
});

test("NX9 --name does not rename an existing add-on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx9-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/manifest.json"), `${JSON.stringify({ name: "Spectrum Text", version: "1.0.0", manifestVersion: 2, entryPoints: [{ type: "panel", id: "panel1", main: "index.html" }] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "src/index.html"), "<!doctype html><html><body><h1>Spectrum Text</h1></body></html>\n");
  const { env, out } = homeEnv(dir);
  const began = run(developCli, ["begin", "--dir", dir, "--name", "Existing One", "--brief", "Add a caption field to the panel", "--out", out], env);
  assert.equal(began.status, 0, began.stdout + began.stderr);
  assert.equal(began.json.nameIgnored, "Existing One");
  assert.equal(run(sessionCli, ["mode", "--set", "chat", "--out", out], env).status, 0);
  assert.equal(run(developCli, ["docs", "--out", out], env, [preloadFixtures]).status, 0);
  assert.equal(run(developCli, ["classify", "--out", out], env).status, 0);
  for (const [id, value] of [["feasibility", "iframe"], ["design", "leave"], ["implement", "write"]]) {
    assert.equal(run(sessionCli, ["ask", "--id", id, "--out", out], env).status, 0);
    assert.equal(run(sessionCli, ["answer", "--id", id, "--value", value, "--out", out], env).status, 0);
  }
  const handed = run(developCli, ["implement", "--out", out], env);
  assert.equal(handed.status, 0, handed.stdout + handed.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "src/manifest.json"), "utf8"));
  assert.equal(manifest.name, "Spectrum Text");
});

test("NX10 the dev server is started with analytics off after the CA exists", async () => {
  const order = [];
  const ready = await openDevServer({
    cwd: "/tmp/addon",
    home: fs.mkdtempSync(path.join(os.tmpdir(), "nx10-")),
    timeoutMs: 1000,
    sleep: async () => {},
    prepareCa() {
      order.push("prepare");
      return { ok: true, action: "local-setup", warning: SSL_WARNING };
    },
    spawnImpl(cmd, args) {
      order.push(args.join(" "));
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
    check: async () => ({ trusted: true }),
    identify: async () => ({ ok: true, name: "Color Note" })
  });
  assert.equal(ready.ok, true);
  assert.deepEqual(order, ["prepare", "start -- --analytics off", "ca", "trust"]);
  assert.match(ready.warning, /sudo/);
  assert.match(ready.warning, /devcert\.crt/);
});

test("NX11 the Express window uses a dedicated profile and no security flag", () => {
  const spec = launchSpec({ id: "local-chrome", spawn: true, file: "/usr/bin/google-chrome" }, { HOME: "/tmp/nx11-home" });
  assert.match(spec.args.join(" "), /--no-first-run/);
  assert.match(spec.args.join(" "), /--user-data-dir=/);
  assert.doesNotMatch(spec.args.join(" "), /ignore-certificate|disable-web-security|allow-insecure/);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nx11-profile-"));
  const sentinel = seedChromeProfile(profile);
  assert.equal(fs.existsSync(sentinel), true);
});

test("NX12 an existing CA is reused and sudo cannot touch the system store", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nx12-"));
  const cert = path.join(home, ".config/Adobe/CCWebAddOn/devcert/certificate-authority/certificate.cert");
  const key = path.join(home, ".config/Adobe/CCWebAddOn/devcert/certificate-authority/private-key.key");
  fs.mkdirSync(path.dirname(cert), { recursive: true });
  fs.writeFileSync(cert, "existing");
  fs.writeFileSync(key, "existing");
  const domain = path.join(home, ".config/Adobe/CCWebAddOn/devcert/domains/localhost/certificate.crt");
  fs.mkdirSync(path.dirname(domain), { recursive: true });
  fs.writeFileSync(domain, "existing-domain");
  const plan = prepareDevCa({ home, run() { throw new Error("openssl should not run"); } });
  assert.equal(plan.action, "reuse");
  assert.match(plan.warning, /system certificate/);
  assert.equal(fs.readFileSync(cert, "utf8"), "existing");
  const guard = sudoGuard();
  const refused = spawnSync(path.join(guard, "sudo"), ["cp", "devcert.crt", SYSTEM_CA], { encoding: "utf8" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /devcert\.crt/);
});

test("X10 listing shots do not quote Get Started", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-list-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>Get Started</title></head><body><h1>Add heading</h1><button>Insert image</button></body></html>\n");
  const listing = fs.mkdtempSync(path.join(os.tmpdir(), "nx-listing-"));
  const prepared = spawnSync(process.execPath, [path.join(reviewSkill, "scripts/prepare-listing.mjs"), "--out", listing], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const filled = fillListingDir(listing, dir, { shotsDir: capturedShots(640, 1280) });
  assert.equal(filled.ok, true, filled.error);
  assert.ok(filled.phrases.includes("Add heading"));
  assert.equal(filled.phrases.includes("Get Started"), false);
  const html = fs.readFileSync(path.join(listing, "01-cover.html"), "utf8");
  assert.match(html, /Add heading/);
  assert.doesNotMatch(html, /Get Started/);
});

test("UX a failed audit is not a green success and a failed fetch is not the template step", () => {
  const app = fs.readFileSync(path.join(reviewSkill, "assets/dashboard/app.js"), "utf8");
  const css = fs.readFileSync(path.join(reviewSkill, "assets/dashboard/app.css"), "utf8");
  assert.match(app, /data-warn/);
  assert.match(app, /failedFinish \? "bad"/);
  assert.match(app, /The template list could not be fetched/);
  assert.match(css, /\.hero\[data-tone="bad"\] \.summary/);
  assert.match(css, /\.step\[data-warn="true"\]/);
  const stopped = developNext({
    mode: "chat",
    kind: "develop",
    steps: [
      { id: "docs", status: "done" }, { id: "origin", status: "done" }, { id: "template", status: "pending" },
      { id: "done", status: "pending" }
    ],
    asks: [{ id: "origin", status: "answered", answer: "new" }],
    develop: { templatesFailed: "offline" }
  });
  assert.equal(stopped.action, "finish");
  assert.match(stopped.say, /template fetch failed/i);
  assert.doesNotMatch(stopped.command, /develop\.mjs templates/);
});
