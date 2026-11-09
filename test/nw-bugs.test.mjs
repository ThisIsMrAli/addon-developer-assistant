import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../.claude/skills/express-addon-review/scripts/lib/chrome.mjs";
import { imageSize } from "../.claude/skills/express-addon-review/scripts/lib/images.mjs";
import { startSession } from "../.claude/skills/express-addon-review/scripts/lib/session.mjs";
import { shownStatusError } from "../.claude/skills/express-addon-review/scripts/lib/audit.mjs";
import { controlFlow, hasColumnPlacement } from "../.claude/skills/express-addon-develop/scripts/lib/code-scan.mjs";
import { classifyFeature, plainSentence } from "../.claude/skills/express-addon-develop/scripts/lib/feasibility.mjs";
import { TEXT_INSIDE_PAGE, verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { fillListingDir, listingFrom } from "../.claude/skills/express-addon-develop/scripts/lib/listing-copy.mjs";
import { exposedSandboxMethods, sandboxApiMismatches, standInSource } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { serveWithStandIn } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { bindGuardToPid, releaseUnboundGuards, sudoGuard } from "../.claude/skills/express-addon-develop/scripts/lib/ssl-setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewSkill = path.join(root, ".claude/skills/express-addon-review");
const browser = process.env.SKIP_BROWSER_TESTS
  ? { skip: "The box runner does not start Chrome or Edge. Set BOX_TEST_BROWSER=1 to run it." }
  : findChrome()
    ? {}
    : { skip: "No Chrome, Edge, or Chromium was found." };

function addon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-addon-"));
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

class Text {
  constructor(value) { this.t = value; this.fs = 100; this.translation = { x: 0, y: 0 }; }
  get boundsLocal() { return { x: 0, y: 0, width: 0.55 * this.fs * this.t.length, height: 1.2 * this.fs }; }
  get boundsInParent() { const box = this.boundsLocal; return { x: this.translation.x, y: this.translation.y, width: box.width, height: box.height }; }
  get centerPointLocal() { const box = this.boundsLocal; return { x: box.width / 2, y: box.height / 2 }; }
  get fullContent() { const self = this; return { applyCharacterStyles(style) { if (style.fontSize) self.fs = style.fontSize; } }; }
  resize({ width, height, behavior }) {
    const box = this.boundsLocal;
    let scale = width / box.width;
    if (height && behavior === "contain") scale = Math.min(scale, height / box.height);
    this.fs *= scale;
  }
  setPositionInParent(point, ref) { this.translation = { x: point.x - ref.x, y: point.y - ref.y }; }
}

class Picture {
  constructor(width, height) { this.w = width; this.h = height; this.translation = { x: 0, y: 0 }; }
  get boundsLocal() { return { x: 0, y: 0, width: this.w, height: this.h }; }
  get boundsInParent() { const box = this.boundsLocal; return { x: this.translation.x, y: this.translation.y, width: box.width, height: box.height }; }
  get centerPointLocal() { return { x: this.w / 2, y: this.h / 2 }; }
  resize({ width, height, behavior }) {
    const box = this.boundsLocal;
    let scale = width / box.width;
    if (height && behavior === "contain") scale = Math.min(scale, height / box.height);
    this.w *= scale;
    this.h *= scale;
  }
  setPositionInParent(point, ref) { this.translation = { x: point.x - ref.x, y: point.y - ref.y }; }
}

function layout(width, height) {
  const children = { items: [], append(node) { this.items.push(node); }, [Symbol.iterator]() { return this.items[Symbol.iterator](); } };
  const page = { width, height, children };
  const editor = {
    context: { insertionParent: page, selection: [] },
    createText: (value) => new Text(value),
    async loadBitmapImage(blob) { return blob; },
    createImageContainer(bitmap) { return new Picture(bitmap.width, bitmap.height); },
    keepContentActiveDuringAsync(_target, _during, after) { after(); return Promise.resolve(); }
  };
  const body = TEXT_INSIDE_PAGE.replace(/^import[^\n]*\n/gm, "").replace(/export\s+(?:async\s+)?function/g, (match) => match.replace(/^export\s+/, ""));
  const api = new Function("editor", "constants", `${body}\nreturn { addHeading, addImage };`)(editor, { ResizeBehavior: { contain: "contain" } });
  return { page, api };
}

function boxOf(node) {
  const box = node.boundsInParent;
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, cx: box.x + box.width / 2 };
}

function overlaps(a, b) {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}

test("NW1 createImageContainer stays inside the documented callback", () => {
  assert.match(TEXT_INSIDE_PAGE, /keepContentActiveDuringAsync/);
  assert.match(TEXT_INSIDE_PAGE, /async \(\) => \{\}/);
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

  const open = `
function placeImageNode(node, page) {
  const box = node.boundsInParent;
  const x = page.width / 2 + box.width;
  node.setPositionInParent({ x, y: 40 }, { x: 0, y: 0 });
}
export async function addImage(blob) {
  const page = editor.context.insertionParent;
  const bitmap = await editor.loadBitmapImage(blob);
  const image = editor.createImageContainer(bitmap);
  page.children.append(image);
  placeImageNode(image, page);
}
`;
  const rejected = verifyFeature({
    dir: addon({
      "manifest.json": manifest(),
      "index.html": "<!doctype html><html><body><button>Add image</button></body></html>\n",
      "code.js": open
    }),
    brief: "Insert an image into the document",
    build: false
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /keepContentActiveDuringAsync|afterAsyncCallback|queueAsyncEdit/);

  const queued = open.replace(
    "const image = editor.createImageContainer(bitmap);\n  page.children.append(image);\n  placeImageNode(image, page);",
    `await editor.queueAsyncEdit(() => {
    const image = editor.createImageContainer(bitmap);
    page.children.append(image);
    placeImageNode(image, page);
  });`
  );
  const viaQueue = verifyFeature({
    dir: addon({
      "manifest.json": manifest(),
      "index.html": "<!doctype html><html><body><button>Add image</button></body></html>\n",
      "code.js": queued
    }),
    brief: "Insert an image into the document",
    build: false
  });
  assert.equal(viaQueue.ok, true, viaQueue.problems.join(" "));
});

test("NW2 a sandbox proxy addImage is not the iframe image API", () => {
  const dir = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add image</button></body></html>\n",
    "code.js": TEXT_INSIDE_PAGE,
    "panel.js": "export class Panel { async add() { await this._sandboxProxy.addImage(this._file); } }\n"
  });
  const ok = verifyFeature({ dir, brief: "Insert an image into the document", build: false });
  assert.equal(ok.ok, true, ok.problems.join(" "));
  assert.doesNotMatch(ok.problems.join(" "), /free-space|cover a heading/);
});

test("NW10 placement accepts equivalent page-width math", () => {
  assert.equal(hasColumnPlacement("const x = page.width * 0.5 + column;"), true);
  assert.equal(hasColumnPlacement("const x = page.width / 2 + column;"), true);
  assert.equal(hasColumnPlacement("const x = page.width / 2;"), false);
  assert.equal(hasColumnPlacement("for (let x = margin; x <= page.width - margin; x += pitch) {}"), true);
  const half = TEXT_INSIDE_PAGE.replaceAll("page.width / 2", "page.width * 0.5");
  const ok = verifyFeature({
    dir: addon({
      "manifest.json": manifest(),
      "index.html": "<!doctype html><html><body><button>Add image</button></body></html>\n",
      "code.js": half
    }),
    brief: "Insert an image into the document",
    build: false
  });
  assert.equal(ok.ok, true, ok.problems.join(" "));
});

test("NW3 and NW11 headings stay aligned, and the sixth stays readable", async () => {
  const six = layout(1920, 1080);
  for (let n = 1; n <= 6; n += 1) six.api.addHeading(`Heading number ${n}`);
  const sixBoxes = six.page.children.items.map(boxOf);
  assert.equal(sixBoxes.length, 6);
  for (const node of six.page.children.items) assert.ok(node.fs >= 24, `font ${node.fs}`);
  for (const box of sixBoxes) {
    assert.ok(Math.abs(box.cx - sixBoxes[0].cx) < 1.5, JSON.stringify(box));
    assert.ok(box.left >= -0.5 && box.top >= -0.5 && box.right <= 1920.5 && box.bottom <= 1080.5);
  }
  for (let i = 1; i < sixBoxes.length; i += 1) assert.ok(sixBoxes[i].top >= sixBoxes[i - 1].bottom - 0.5);

  const first = layout(1920, 1080);
  await first.api.addImage({ width: 1600, height: 1000 });
  first.api.addHeading("Heading number 1");
  first.api.addHeading("Heading number 2");
  first.api.addHeading("Heading number 3");
  const headings = first.page.children.items.filter((node) => node.t);
  const picture = first.page.children.items.find((node) => node.w);
  assert.equal(headings.length, 3);
  for (const node of headings) assert.ok(node.fs >= 24, `font ${node.fs}`);
  const boxes = first.page.children.items.map(boxOf);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) assert.equal(overlaps(boxes[i], boxes[j]), false);
    assert.ok(boxes[i].left >= -0.5 && boxes[i].top >= -0.5 && boxes[i].right <= 1920.5 && boxes[i].bottom <= 1080.5);
  }
  const headingBoxes = headings.map(boxOf);
  for (const box of headingBoxes) assert.ok(Math.abs(box.cx - headingBoxes[0].cx) < 1.5);
  assert.ok(boxOf(picture).bottom <= 1080.5);

  const packed = layout(320, 200);
  let message = "";
  for (let n = 0; n < 12; n += 1) {
    const before = packed.page.children.items.length;
    const result = packed.api.addHeading(`Heading number ${n}`);
    if (packed.page.children.items.length === before) {
      message = result;
      break;
    }
  }
  assert.match(message, /readable size/);
  assert.ok(packed.page.children.items.length < 12);
  for (const node of packed.page.children.items) assert.ok(node.fs >= 18, `font ${node.fs}`);

  const mixed = layout(1920, 1080);
  mixed.api.addHeading("One");
  mixed.api.addHeading("Two");
  mixed.api.addHeading("Three");
  await mixed.api.addImage({ width: 1600, height: 1000 });
  mixed.api.addHeading("Four");
  const labels = mixed.page.children.items.filter((node) => node.t);
  assert.deepEqual(labels.map((node) => node.t), ["One", "Two", "Three", "Four"]);
  const labelBoxes = labels.map(boxOf);
  for (const box of labelBoxes) assert.ok(Math.abs(box.cx - labelBoxes[0].cx) < 1.5, JSON.stringify(labelBoxes));
  assert.ok(labelBoxes[1].top >= labelBoxes[0].bottom - 0.5);
  assert.ok(labelBoxes[2].top >= labelBoxes[1].bottom - 0.5);
  assert.ok(labelBoxes[3].top >= labelBoxes[2].bottom - 0.5);
  const all = mixed.page.children.items.map(boxOf);
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) assert.equal(overlaps(all[i], all[j]), false, `${i} overlaps ${j}`);
    assert.ok(all[i].left >= -0.5 && all[i].top >= -0.5 && all[i].right <= 1920.5 && all[i].bottom <= 1080.5, JSON.stringify(all[i]));
  }
  for (const node of labels) assert.ok(node.fs >= 24, `font ${node.fs}`);
});

test("NW4 the sudo guard stays until the server process exits", async () => {
  const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  server.unref();
  const guard = sudoGuard();
  try {
    bindGuardToPid(guard, server.pid);
    releaseUnboundGuards();
    assert.equal(fs.existsSync(guard), true);
    process.kill(server.pid, "SIGKILL");
    const started = Date.now();
    while (fs.existsSync(guard) && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fs.existsSync(guard), false);
  } finally {
    try { process.kill(server.pid, "SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(guard, { recursive: true, force: true });
  }
});

test("NW5 a catch chain, a mapped function, and a bound method are covered", () => {
  const covered = `
function boom() { throw new Error("x"); }
Promise.resolve().then(boom).catch(() => {});
function requireText(value) { if (!value) throw new Error("need text"); }
try { [value].map(requireText); } catch (error) {}
function validate(text) { if (!text) throw new Error("need"); }
const fn = validate;
function _guard(action) { try { [text].map(action); } catch (error) { return error; } }
_guard(fn);
class Panel {
  _run(label, action) { try { return action(); } catch (error) { return error; } }
  _do() { throw new Error("bound"); }
  go() { this._run("H", this._do.bind(this)); }
}
`;
  assert.equal(controlFlow([{ rel: "panel.js", text: covered }]).unhandledThrow, false);

  const open = `
Promise.resolve().then(() => { throw new Error("open"); });
function bare(value) { throw new Error(value); }
[value].map(bare);
button.addEventListener("click", () => { throw new Error("click"); });
function hidden() { throw new Error("deep"); }
function mid() { hidden(); }
mid();
`;
  assert.equal(controlFlow([{ rel: "panel.js", text: open }]).unhandledThrow, true);
});

test("NW6 the stand-in answers only exposed sandbox methods", () => {
  const source = `
    runtime.exposeApi({ insertHeading(text) { return text; } });
    this._sandboxProxy.addHeading("Hi");
  `;
  assert.deepEqual(exposedSandboxMethods(source), ["insertHeading"]);
  const standIn = standInSource(exposedSandboxMethods(source));
  assert.match(standIn, /insertHeading/);
  assert.doesNotMatch(standIn, /addHeading/);
  const mismatches = sandboxApiMismatches([
    { rel: "code.js", text: "runtime.exposeApi({ insertHeading() {} });" },
    { rel: "panel.js", text: "this._sandboxProxy.addHeading('Hi');" }
  ]);
  assert.deepEqual(mismatches, ["addHeading"]);
  const rejected = verifyFeature({
    dir: addon({
      "manifest.json": manifest(),
      "index.html": "<!doctype html><html><body><button>Add heading</button></body></html>\n",
      "code.js": "import { editor } from 'express-document-sdk';\nruntime.exposeApi({ insertHeading() { editor.createText('Hi'); } });\n",
      "panel.js": "export class Panel { add() { this._sandboxProxy.addHeading('Hi'); } }\n"
    }),
    brief: "Add a styled heading to the document",
    build: false
  });
  assert.match(rejected.problems.join(" "), /addHeading/);
  assert.match(rejected.problems.join(" "), /exposeApi/);
});

test("NW7 a shown status error is recorded with the button press", () => {
  assert.equal(shownStatusError("Heading\nAdd heading", "Heading\nAdd heading"), "");
  assert.equal(shownStatusError("Add heading", "Add heading\nType a heading first."), "");
  assert.match(shownStatusError("Add heading", "Add heading\nCould not add the heading."), /Could not add the heading/);
});

test("NW7 the audit fills a field, records the press, and catches status text", { ...browser, timeout: 120_000 }, async () => {
  const dir = addon({
    "index.html": `<!doctype html><html><body>
      <label>Heading <input id="text"></label>
      <p id="status"></p>
      <button id="add">Add heading</button>
      <script>
        document.getElementById("add").addEventListener("click", () => {
          const value = document.getElementById("text").value;
          if (!value) { document.getElementById("status").textContent = "Type a heading first."; return; }
          try { throw new Error("Could not add the heading."); }
          catch (error) { document.getElementById("status").textContent = error.message; }
        });
      </script>
    </body></html>\n`
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nw7-out-"));
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
  assert.match(result.bugs.map((bug) => bug.text).join(" "), /Could not add the heading/);
  const audit = JSON.parse(fs.readFileSync(path.join(out, "audit.json"), "utf8"));
  assert.ok(audit.actions.some((action) => /add heading/i.test(action.label)));
  assert.match(audit.actions.map((action) => action.error).join(" "), /Could not add the heading/);
});

test("NW8 listing copy is written, and the stage is a panel", () => {
  const listing = listingFrom({
    name: "Heading Image",
    brief: "A Spectrum panel with an sp-textfield and an sp-button that adds two headings for the user, with createRenditions."
  });
  assert.match(listing.summary, /heading/i);
  assert.doesNotMatch(`${listing.summary} ${listing.description}`, /sp-textfield|createRenditions|two headings for the user/i);
  assert.equal(listing.keywords.includes("two"), false);
  assert.equal(listing.keywords.includes("user"), false);
  assert.equal(listing.keywords.includes("sign"), false);
  assert.equal(listing.keywords.some((word) => /sp-|createrenditions|clientstorage/i.test(word)), false);
  const dir = addon({ "index.html": "<!doctype html><html><body><h1>Add heading</h1><button>Add image</button></body></html>\n" });
  const listingDir = fs.mkdtempSync(path.join(os.tmpdir(), "nw8-listing-"));
  fs.writeFileSync(path.join(listingDir, "02-feature.html"), "<div class=\"stage\"><img src=\"panel-front.png\" alt=\"\"></div>\n");
  const filled = fillListingDir(listingDir, dir);
  assert.equal(filled.ok, true, filled.error);
  const png = fs.readFileSync(path.join(listingDir, "panel-front.png"));
  const size = imageSize(png);
  assert.ok(size.width >= 300 && size.height >= 200, JSON.stringify(size));
});

test("NW9 feasibility evidence is a sentence", () => {
  const fragment = "`, `editor.createText()` - Create content&lt;br/&gt;• `editor.";
  const plain = plainSentence(fragment);
  assert.match(plain, /The document sandbox uses editor\.createText\(\) to create content\./);
  assert.doesNotMatch(plain, /^,|Create content editor/);
  const found = classifyFeature("Add a heading to the document", {
    architecture: fragment,
    document: "",
    guide: "Spectrum Web Components",
    label: "fresh"
  });
  assert.match(found.summary, /The document sandbox uses editor\.createText\(\) to create content\./);
  assert.doesNotMatch(found.summary, /Create content editor/);
});
