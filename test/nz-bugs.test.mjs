import test from "node:test";
import assert from "node:assert/strict";
import { capturedShots } from "./helpers.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADOBE_RULES } from "../.claude/skills/express-addon-review/scripts/lib/adobe.mjs";
import { findChrome } from "../.claude/skills/express-addon-review/scripts/lib/chrome.mjs";
import { launch } from "../.claude/skills/express-addon-review/scripts/lib/cdp.mjs";
import { scanAddon } from "../.claude/skills/express-addon-review/scripts/lib/scan.mjs";
import { startSession } from "../.claude/skills/express-addon-review/scripts/lib/session.mjs";
import { controlFlow } from "../.claude/skills/express-addon-develop/scripts/lib/code-scan.mjs";
import { classifyFeature, plainSentence, sentenceWith } from "../.claude/skills/express-addon-develop/scripts/lib/feasibility.mjs";
import { openDevServer, waitForDevServer } from "../.claude/skills/express-addon-develop/scripts/lib/express-host.mjs";
import { TEXT_INSIDE_PAGE, scrubTemplateChrome, verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { fillListingDir, listingFrom } from "../.claude/skills/express-addon-develop/scripts/lib/listing-copy.mjs";
import { exposedSandboxMethods, pngBytes, serveWithStandIn, standInSource } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { prepareDevCa } from "../.claude/skills/express-addon-develop/scripts/lib/ssl-setup.mjs";
import { uncaughtMessages } from "../.claude/skills/express-addon-review/scripts/lib/audit.mjs";
import { boxOf, inside, loadSnippet, overlaps } from "./sandbox-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewSkill = path.join(root, ".claude/skills/express-addon-review");
const RAW = "https://raw.githubusercontent.com/adobe/create-ccweb-add-on/main/packages/create-ccweb-add-on/templates/swc-javascript-with-document-sandbox/template";
const browser = process.env.SKIP_BROWSER_TESTS
  ? { skip: "The box runner does not start Chrome or Edge. Set BOX_TEST_BROWSER=1 to run it." }
  : findChrome()
    ? {}
    : { skip: "No Chrome, Edge, or Chromium was found." };

function addon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-addon-"));
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

const manifest = () => `${JSON.stringify({
  name: "Sample",
  testId: "11111111-1111-4111-8111-111111111111",
  version: "1.0.0",
  manifestVersion: 2,
  requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
  entryPoints: [{ type: "panel", id: "panel1", main: "index.html", documentSandbox: "code.js" }]
}, null, 2)}\n`;

async function officialFile(rel) {
  const cached = path.join(os.tmpdir(), "ccweb-templates", "swc-javascript-with-document-sandbox", rel);
  if (fs.existsSync(cached)) return fs.readFileSync(cached, "utf8");
  const response = await fetch(`${RAW}/${rel}`);
  assert.equal(response.ok, true, `${rel} ${response.status}`);
  return response.text();
}

test("NZ1 a wrapper catch covers a throw, including two calls deep, and a bare throw does not", async () => {
  const sandbox = await officialFile("src/sandbox/code.js");
  assert.match(sandbox, /runtime\.exposeApi/);
  const wrapped = `${sandbox}
function _run(label, action) {
  try { return action(); } catch (error) { return error; }
}
function _guard(fn) {
  try { return fn(); } catch (error) { return error; }
}
class FolderBrowser {
  async _act(fn) {
    try { return await fn(); } catch (error) { return error; }
  }
  async _open() { return this.listFolder(); }
  listFolder() { throw new Error("missing folder"); }
}
_run("heading", () => { throw new Error("sandbox heading"); });
_guard(() => { throw new Error("guarded"); });
const browser = new FolderBrowser();
_guard(() => browser._open());
browser._act(() => { throw new Error("act"); });
`;
  const flow = controlFlow([{ rel: "src/sandbox/code.js", text: wrapped }]);
  assert.equal(flow.unhandledThrow, false);

  const bare = controlFlow([{ rel: "src/sandbox/code.js", text: `${sandbox}\nthrow new Error("boom");\n` }]);
  assert.equal(bare.unhandledThrow, true);
  const unused = controlFlow([{ rel: "code.js", text: "function never() { throw new Error('later'); }\n" }]);
  assert.equal(unused.unhandledThrow, true);
  const top = controlFlow([{ rel: "index.js", text: "const token = await addOnUISdk.app.oauth.authorize();\n" }]);
  assert.equal(top.unhandledAuthorize, true);
});

test("NZ2 the stand-in exposes the add-on's sandbox API and NZ4 returns a PNG", async () => {
  const sandbox = await officialFile("src/sandbox/code.js");
  const official = exposedSandboxMethods(sandbox);
  assert.ok(official.includes("createRectangle"), official.join(","));
  const heading = exposedSandboxMethods(`
    const sandboxApi = { addHeading(text) { return text; }, addImage(blob) { return blob; } };
    runtime.exposeApi(sandboxApi);
    this._sandboxProxy.addHeading(value);
  `);
  assert.deepEqual(heading.sort(), ["addHeading", "addImage"]);
  const source = standInSource(heading);
  assert.match(source, /addHeading: async \(\) => ""/);
  assert.match(source, /addImage: async \(\) => ""/);
  assert.doesNotMatch(source, /api: "addHeading"|\{ ok: true, api/);
  assert.doesNotMatch(source, /new Blob\(\["png"\]\)/);
  const png = pngBytes();
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
  assert.equal(png[2], 0x4e);
  assert.equal(png[3], 0x47);
  assert.match(source, /iVBORw0KGgo/);
});

test("NZ3 a docs step with zero failures is not a failed step", () => {
  const source = fs.readFileSync(path.join(reviewSkill, "assets/dashboard/app.js"), "utf8");
  const detailFailed = new Function(`${source.match(/function detailFailed\([\s\S]*?\n\}/)[0]}\nreturn detailFailed;`)();
  assert.equal(detailFailed("10 fresh, 0 stale, 0 failed"), false);
  assert.equal(detailFailed("Audit failed: 1 error"), true);
  assert.equal(detailFailed("1 failed"), true);
  assert.equal(detailFailed("0 errors"), false);
});

test("NZ5 listing copy uses the brief, and the stage keeps a panel image", () => {
  const listing = listingFrom({
    name: "Heading Image",
    brief: "Add a heading and then an image on the page."
  });
  assert.match(listing.summary, /heading/i);
  assert.match(listing.summary, /image/i);
  assert.doesNotMatch(listing.summary, /then an image/i);
  assert.doesNotMatch(listing.description, /^Heading Image\. Heading Image\.$/);
  const dir = addon({ "index.html": "<!doctype html><html><body><h1>Add heading</h1></body></html>\n" });
  const listingDir = fs.mkdtempSync(path.join(os.tmpdir(), "nz5-listing-"));
  fs.writeFileSync(path.join(listingDir, "02-feature.html"), "<div class=\"stage\"><img src=\"panel-front.png\" alt=\"\"></div><p>Short phrase from the UI</p>\n");
  const filled = fillListingDir(listingDir, dir, { shotsDir: capturedShots(640, 1280) });
  assert.equal(filled.ok, true, filled.error);
  const html = fs.readFileSync(path.join(listingDir, "02-feature.html"), "utf8");
  assert.match(html, /panel-front\.png/);
  const png = fs.readFileSync(path.join(listingDir, "panel-front.png"));
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
});

test("NZ6 headings wrap instead of stacking, and an image uses that same slot", async () => {
  const assertInside = (boxes, width, height) => {
    for (const box of boxes) assert.ok(inside(box, width, height), JSON.stringify(box));
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) assert.equal(overlaps(boxes[i], boxes[j]), false, `${i} overlaps ${j}`);
    }
  };
  const mixed = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080 });
  mixed.api.addHeading("Hi");
  mixed.api.addHeading("Hi");
  mixed.api.addHeading("Hi");
  const beforeImage = mixed.texts().map(boxOf);
  assert.equal(beforeImage.length, 3);
  for (const box of beforeImage) assert.ok(Math.abs(box.cx - 960) < 1, JSON.stringify(box));
  assert.ok(beforeImage[1].top >= beforeImage[0].bottom - 0.5);
  assert.ok(beforeImage[2].top >= beforeImage[1].bottom - 0.5);
  assert.ok(mixed.texts().every((node) => node.fontSize <= 72));
  await mixed.api.addImage({ width: 1600, height: 900 });
  mixed.api.addHeading("After");
  const boxes = mixed.nodes().map(boxOf);
  assert.equal(boxes.length, 5);
  assertInside(boxes, 1920, 1080);
  const image = boxOf(mixed.images()[0]);
  const lastHeading = mixed.texts().map(boxOf).reduce((low, box) => (box.bottom > low.bottom ? box : low));
  assert.ok(image.top >= lastHeading.bottom - 0.5, `image ${JSON.stringify(image)} is not below ${JSON.stringify(lastHeading)}`);
  assert.ok(Math.abs(image.cx - 960) < 80, "a fitted image stays in the content column");
  const full = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080 });
  for (let n = 0; n < 8; n += 1) full.api.addHeading("Heading");
  const packed = full.texts().map(boxOf);
  assert.equal(packed.length, 8);
  assertInside(packed, 1920, 1080);
  assert.ok(Math.abs(packed[0].cx - 960) < 1);
  const centered = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add image</button></body></html>\n",
    "code.js": "export async function addImage(blob) { const page = editor.context.insertionParent; const bitmap = await editor.loadBitmapImage(blob); const image = editor.createImageContainer(bitmap); page.children.append(image); image.setPositionInParent({ x: page.width / 2, y: page.height / 2 }, { x: 0, y: 0 }); }\n"
  });
  const rejected = verifyFeature({ dir: centered, brief: "Insert an image into the document", build: false });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /boundsInParent|cover|free-space/);
  const accepted = verifyFeature({
    dir: addon({
      "manifest.json": manifest(),
      "index.html": "<!doctype html><html><body><button>Add image</button></body></html>\n",
      "code.js": TEXT_INSIDE_PAGE
    }),
    brief: "Insert an image into the document",
    build: false
  });
  assert.equal(accepted.ok, true, accepted.problems.join(" "));
});

test("NZ8 template boilerplate is not a name error, and a new CA says it was created", async () => {
  const html = await officialFile("src/index.html");
  assert.match(html, /<title>\s*Get Started\s*<\/title>/);
  assert.match(html, /Adobe,\s*Express,\s*Add-On/);
  const dir = addon({
    "manifest.json": manifest(),
    "src/index.html": html,
    "src/ui/index.js": "console.log('panel');\n"
  });
  const before = scanAddon(dir, { docs: Object.fromEntries(ADOBE_RULES.map((rule) => [rule.sourceKey, rule.evidence])) });
  const beforeIds = before.findings.map((item) => item.id);
  assert.equal(beforeIds.includes("name-adobe-express"), false, beforeIds.join(","));
  assert.equal(beforeIds.includes("spelling-add-on"), false, beforeIds.join(","));
  const recorded = verifyFeature({ dir, brief: "Add a styled heading to the document", build: false });
  assert.equal(recorded.ok, false);
  assert.match(recorded.problems.join(" "), /Get Started/);
  scrubTemplateChrome(dir, "Heading Panel");
  const cleaned = fs.readFileSync(path.join(dir, "src/index.html"), "utf8");
  assert.match(cleaned, /<title>Heading Panel<\/title>/);
  assert.doesNotMatch(cleaned, /Adobe,\s*Express,\s*Add-On/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nz8-ca-"));
  const created = prepareDevCa({ home });
  assert.equal(created.ok, true, created.error);
  assert.equal(created.action, "local-setup");
  assert.match(created.warning, /A new CA was created in this home/);
  assert.doesNotMatch(created.warning, /An existing CA in this home is reused/);
  const again = prepareDevCa({ home, run() { throw new Error("openssl should not run"); } });
  assert.equal(again.action, "reuse");
  assert.match(again.warning, /An existing CA in this home is reused/);
});

test("NY8 the encoded break tag is not left in the evidence", () => {
  const raw = "createRectangle(), editor.createText() - Create content&lt;br/&gt;• `editor.`";
  const plain = plainSentence(raw);
  assert.doesNotMatch(plain, /&lt;|&gt;|<br|br\/|`|•/);
  const sentence = sentenceWith(`createRectangle(), editor.createText() - Create content&lt;br/&gt;• editor.createText() adds the heading.`, "editor.createText()");
  const found = classifyFeature("Add a heading to the document", {
    architecture: `The document sandbox exposes createRectangle(), editor.createText() - Create content&lt;br/&gt;• editor.createText() for text.`,
    document: "",
    guide: "Spectrum Web Components",
    label: "fresh"
  });
  assert.doesNotMatch(plainSentence(sentence), /createRectangle|br\//);
  assert.doesNotMatch(found.summary, /createRectangle|br\/|<br|`/);
});

test("NZ9 Chrome temp stays inside the profile", { ...browser, timeout: 40_000 }, async () => {
  const page = await launch({ width: 400, height: 300 });
  assert.ok(page.scratch.startsWith(page.profile));
  assert.equal(path.basename(page.scratch), "tmp");
  await page.goto("about:blank");
  await page.close();
  assert.equal(fs.existsSync(page.profile), false);
  assert.equal(fs.existsSync(page.scratch), false);
});

test("NZ10 the sudo guard lives as long as the dev server", async () => {
  const ready = await openDevServer({
    cwd: "/tmp/addon",
    timeoutMs: 0,
    sleep: async () => {},
    spawnImpl() { return { pid: 9, unref() {} }; },
    caReady: () => true,
    trust: () => ({ ok: true }),
    check: async () => ({ trusted: true }),
    identify: async () => ({ ok: true, name: "Color Note" })
  });
  assert.equal(ready.ok, true);
  assert.equal(fs.existsSync(ready.guard), true);
  assert.match(ready.guard, /express-no-sudo/);
  let spawned;
  const waited = await waitForDevServer({
    cwd: "/tmp/addon",
    timeoutMs: 0,
    sleep: async () => {},
    spawnImpl(cmd, args, options) {
      spawned = options;
      return { pid: 4, unref() {} };
    },
    check: async () => ({ trusted: true }),
    identify: async () => ({ ok: true, name: "Color Note" })
  });
  assert.equal(waited.ok, true);
  assert.match(spawned.env.PATH, /express-no-sudo/);
  assert.equal(fs.existsSync(spawned.env.PATH.split(path.delimiter)[0]), true);
});

test("NZ7 console uncaught errors fail the audit, and a primary click is reported", { ...browser, timeout: 120_000 }, async () => {
  const planted = "[Add-on: Heading Image] Uncaught Exception: Error: planted unhandled error";
  const rejection = "[Add-on: Heading Image] Unhandled Promise Rejection: planted";
  assert.equal(uncaughtMessages([planted, planted, rejection]).length, 2);
  const dir = addon({
    "index.html": `<!doctype html><html><body><p>Heading Image panel</p><button id="add">Add heading</button><script>
      console.error(${JSON.stringify(planted)});
      console.error(${JSON.stringify(rejection)});
      document.getElementById("add").addEventListener("click", () => {
        console.error("this._sandboxProxy.addHeading is not a function");
      });
    </script></body></html>\n`
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nz7-out-"));
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ ok: true, findings: [], addon: "Heading Image", projectPath: dir, views: [] }));
  startSession(out, JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")));
  const served = await serveWithStandIn(dir);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(reviewSkill, "scripts/audit.mjs"), "--out", out, "--url", served.url], {
      env: { ...process.env, EXPRESS_REVIEW_NO_OPEN: "1" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", () => {
      served.close().finally(() => {
        const line = stdout.trim().split("\n").filter((item) => item.startsWith("{")).at(-1);
        if (!line) reject(new Error(stderr || stdout || "audit produced no JSON"));
        else resolve(JSON.parse(line));
      });
    });
  });
  assert.equal(result.ok, false);
  assert.match(result.bugs.map((bug) => `${bug.rule} ${bug.text}`).join(" "), /script-error/);
  assert.match(result.bugs.map((bug) => bug.text).join(" "), /Uncaught Exception|Unhandled Promise Rejection|addHeading is not a function/);
});
