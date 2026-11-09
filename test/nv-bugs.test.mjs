/**
 * Regression tests for the rerun5 findings (NV1-NV14) and Adobe's real-Express 1.0.4 result.
 * The placement rules are checked by running the sandbox code on sample pages, so a rule passes
 * any code that places content correctly and fails any code that does not, whatever it is named.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capturedShots } from "./helpers.mjs";
import { boxOf, inside, loadSnippet, overlaps, fontSizeOf } from "./sandbox-harness.mjs";
import { findChrome } from "../.claude/skills/express-addon-review/scripts/lib/chrome.mjs";
import { launch } from "../.claude/skills/express-addon-review/scripts/lib/cdp.mjs";
import { DEEP_TEXT, exercisePrimary, pressErrorLine, serveFolder, shownStatusError } from "../.claude/skills/express-addon-review/scripts/lib/audit.mjs";
import { ASPECT_MESSAGE, createDocument } from "../.claude/skills/express-addon-develop/scripts/lib/document-stand-in.mjs";
import { TEXT_INSIDE_PAGE, verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { featureFacts, fillListingDir, listingFrom } from "../.claude/skills/express-addon-develop/scripts/lib/listing-copy.mjs";
import { capturePanelShots } from "../.claude/skills/express-addon-develop/scripts/lib/panel-capture.mjs";
import { exposedSandboxMethods, panelSandboxCalls, sandboxApiMismatches, standInSource } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { nextVersion, setAddonVersion } from "../.claude/skills/express-addon-develop/scripts/lib/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const developScripts = path.join(root, ".claude/skills/express-addon-develop/scripts");
const reviewScripts = path.join(root, ".claude/skills/express-addon-review/scripts");
const OLD_SANDBOX = fs.readFileSync(path.join(root, "test/fixtures/rerun5-1.0.4-sandbox.code.txt"), "utf8");

const browser = process.env.SKIP_BROWSER_TESTS
  ? { skip: "The box runner does not start Chrome or Edge. Set BOX_TEST_BROWSER=1 to run it." }
  : findChrome()
    ? {}
    : { skip: "No Chrome, Edge, or Chromium was found." };

function addon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nv-addon-"));
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

const manifest = (extra = {}) => `${JSON.stringify({
  name: "Sample",
  testId: "11111111-1111-4111-8111-111111111111",
  version: "1.0.0",
  manifestVersion: 2,
  requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
  entryPoints: [{ type: "panel", id: "panel1", main: "index.html", documentSandbox: "code.js" }],
  ...extra
}, null, 2)}\n`;

const PANEL = "<!doctype html><html><body><sp-textfield label=\"Heading\"></sp-textfield><button>Add heading</button><button>Add image</button></body></html>\n";
const BOTH = "Add a heading and an image to the page";

function judge(code, brief = BOTH, panel = PANEL) {
  return verifyFeature({ dir: addon({ "manifest.json": manifest(), "index.html": panel, "code.js": code }), brief, build: false });
}

function mutate(from, to) {
  assert.ok(TEXT_INSIDE_PAGE.includes(from), `snippet no longer contains: ${from}`);
  return TEXT_INSIDE_PAGE.replace(from, to);
}

function columnsOf(nodes) {
  const columns = [];
  for (const node of nodes) {
    const box = boxOf(node);
    const column = columns.find((item) => Math.abs(item.cx - box.cx) <= 2);
    if (column) column.nodes.push(node);
    else columns.push({ cx: box.cx, nodes: [node] });
  }
  return columns.sort((a, b) => a.cx - b.cx);
}

// NV1 ------------------------------------------------------------------------------------------

test("NV1 status errors are read from shown text, including messages without the word error", () => {
  for (const shown of [
    "TypeError: this._sandboxProxy.addHeading is not a function",
    "Heading failed: no page is open.",
    "Cannot read properties of undefined (reading 'children')",
    "Aspect ratio of initialSize must match aspect ratio of bitmapData to within 1%",
    "Could not add the image."
  ]) {
    assert.equal(shownStatusError("Add heading", `Add heading\n${shown}`), shown, shown);
  }
  assert.equal(shownStatusError("Add heading", "Add heading\nHeading added."), "");
  assert.equal(shownStatusError("Add heading", "Add heading\nType a heading first."), "");
  assert.equal(shownStatusError("Heading failed earlier", "Heading failed earlier"), "", "text that was already there is not this press");
  assert.match(pressErrorLine(["express-sdk-stand-in: sandbox addImage() threw: Aspect ratio of initialSize must match"]), /addImage/);
  assert.match(DEEP_TEXT, /shadowRoot/);
  assert.doesNotMatch(DEEP_TEXT, /body\.innerText/);
});

test("NV1 the audit reads a shadow-DOM status and waits for a delayed error after each press", browser, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nv1-panel-"));
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><body><heading-panel></heading-panel><script type="module">
    const mode = new URLSearchParams(location.search).get("mode");
    const shown = {
      late: "TypeError: this._sandboxProxy.addHeading is not a function",
      failed: "Heading failed: the sandbox did not answer.",
      cannot: "Cannot read properties of undefined (reading 'children')",
      ok: "Heading added."
    }[mode];
    customElements.define("heading-panel", class extends HTMLElement {
      connectedCallback() {
        const shadow = this.attachShadow({ mode: "open" });
        shadow.innerHTML = '<button>Add heading</button><p id="status"></p>';
        shadow.querySelector("button").addEventListener("click", () => {
          setTimeout(() => { shadow.querySelector("#status").textContent = shown; }, mode === "late" ? 900 : 100);
        });
      }
    });
  </script></body></html>\n`);
  const server = await serveFolder(dir);
  const page = await launch({ width: 320, height: 640, scale: 1 });
  try {
    const base = `http://127.0.0.1:${server.port}/index.html`;
    for (const mode of ["late", "failed", "cannot"]) {
      const [action] = await exercisePrimary(page, `${base}?mode=${mode}`, { watchMs: 2500 });
      assert.equal(action.label, "Add heading");
      assert.equal(action.ok, false, `${mode}: ${JSON.stringify(action)}`);
      assert.ok(action.error, mode);
    }
    const [fine] = await exercisePrimary(page, `${base}?mode=ok`, { watchMs: 1200 });
    assert.equal(fine.ok, true, JSON.stringify(fine));
    assert.match(fine.status, /Heading added/);
  } finally {
    await page.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// NV2 ------------------------------------------------------------------------------------------

test("NV2 wrong placement maths is rejected by measuring the result on sample pages", () => {
  const wrong = {
    "a third instead of the centre": mutate("return { centre: margin + width / 2 + index * (width + gutter), width };", "return { centre: margin + width / 3 + index * (width + gutter), width };"),
    "everything at the origin": mutate("node.setPositionInParent({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, node.centerPointLocal);", "node.setPositionInParent({ x: 0, y: 0 }, { x: 0, y: 0 });"),
    "no margin and no page check": mutate("return Math.round(Math.min(page.width, page.height) * 0.08);", "return -40;"),
    "fixed coordinates": mutate("node.setPositionInParent({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, node.centerPointLocal);", "node.setPositionInParent({ x: 400, y: 300 }, node.centerPointLocal);"),
    "existing content ignored": mutate("for (const box of blocked) if (rectsOverlap(rect, box)) { hit = box; break; }", ""),
    "top-left anchor at the slot centre": mutate("node.setPositionInParent({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, node.centerPointLocal);", "node.setPositionInParent({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, { x: 0, y: 0 });"),
    "half of an unrelated width": mutate("const usable = page.width - margin * 2;\n  const gutter", "const usable = page.height - margin * 2;\n  const gutter")
  };
  for (const [name, code] of Object.entries(wrong)) {
    const result = judge(code);
    assert.equal(result.ok, false, `${name} was accepted`);
    assert.match(result.problems.join(" "), /lands at|overlap|not on one shared line|not below|page|edge/, name);
  }
});

test("NV2 equivalent maths with other names or argument order is accepted", () => {
  const renamed = TEXT_INSIDE_PAGE
    .replace("const scale = Math.min(1, usable / entry.width, tallest / entry.height);", "const scale = Math.min(tallest / entry.height, usable / entry.width, 1);");
  assert.notEqual(renamed, TEXT_INSIDE_PAGE);
  const swapped = mutate("return Math.min(72, Math.round(page.width / 16));", "return Math.min(Math.round(page.width / 16), 72);");
  const destructured = mutate("  const margin = marginOf(page);\n  const usable = page.width - margin * 2;\n  const gutter", "  const margin = marginOf(page);\n  const { width: pageWidth } = page;\n  const usable = pageWidth - 2 * margin;\n  const gutter");
  for (const [name, code] of Object.entries({ renamed, swapped, destructured })) {
    const result = judge(code);
    assert.equal(result.ok, true, `${name}: ${result.problems.join(" ")}`);
  }
});

// NV4 / NV5 ------------------------------------------------------------------------------------

test("NV4 the panel's sandbox calls are found through aliases, destructuring and any field name", () => {
  assert.deepEqual(panelSandboxCalls('const proxy = await runtime.apiProxy("documentSandbox"); const api = proxy; await api.addHeading(value);'), ["addHeading"]);
  assert.deepEqual(panelSandboxCalls('const { addHeading } = await runtime.apiProxy("documentSandbox"); await addHeading(value);'), ["addHeading"]);
  const fields = 'class Panel { async init() { this._api = await runtime.apiProxy("documentSandbox"); this._docApi = this._api; } go() { this._docApi.addHeading("x"); this._api.addImage(blob); } }';
  assert.deepEqual(panelSandboxCalls(fields).sort(), ["addHeading", "addImage"]);
  const dir = addon({
    "manifest.json": manifest(),
    "index.html": PANEL,
    "code.js": TEXT_INSIDE_PAGE,
    "panel.js": `import addOnUISdk from "https://new.express.adobe.com/static/add-on-sdk/sdk.js";\naddOnUISdk.ready.then(async () => {\n  const { runtime } = addOnUISdk.instance;\n  ${fields}\n  const p = new Panel(); await p.init(); p.go();\n});\n`
  });
  const result = verifyFeature({ dir, brief: BOTH, build: false });
  assert.equal(result.ok, true, result.problems.join(" "));
  const files = [{ rel: "code.js", text: TEXT_INSIDE_PAGE }, { rel: "panel.js", text: fields }];
  assert.deepEqual(sandboxApiMismatches(files), []);
});

test("NV5 exposeApi is read through alias of alias, spread, assigned properties, Object.assign and wrappers", () => {
  const cases = {
    "alias of alias": "const api = { addHeading(t) {}, addImage(b) {} }; const a2 = api; const a3 = a2; runtime.exposeApi(a3);",
    spread: "const base = { addHeading() {} }; runtime.exposeApi({ ...base, addImage() {} });",
    assigned: "const api = {}; api.addHeading = () => {}; api.addImage = function () {}; runtime.exposeApi(api);",
    "Object.assign": "const api = Object.assign({}, { addHeading() {} }, { addImage: () => 1 }); runtime.exposeApi(api);",
    wrappers: "function addHeading(t) {} function addImage(b) {} runtime.exposeApi({ addHeading: (t) => addHeading(t), addImage: async (b) => addImage(b) });"
  };
  for (const [name, source] of Object.entries(cases)) assert.deepEqual(exposedSandboxMethods(source).sort(), ["addHeading", "addImage"], name);
  const stand = standInSource(exposedSandboxMethods(cases.spread));
  assert.match(stand, /addHeading/);
  assert.match(stand, /addImage/);
});

// NV6 ------------------------------------------------------------------------------------------

test("NV6 an added image keeps its bitmap's aspect ratio (1600x900 and 600x1200)", async () => {
  for (const [width, height] of [[1600, 900], [600, 1200]]) {
    const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1080, height: 1080 });
    assert.equal(await run.api.addImage({ width, height }), "");
    const [image] = run.images();
    const box = boxOf(image);
    assert.ok(Math.abs(box.width / box.height - width / height) / (width / height) <= 0.01, `${width}x${height} became ${box.width}x${box.height}`);
    assert.ok(inside(box, 1080, 1080));
  }
});

test("NV6 the stand-in enforces Express's 1% initialSize rule, so record rejects the 1.0.4 snippet", async () => {
  const doc = createDocument();
  const bitmap = await doc.editor.loadBitmapImage({ width: 1600, height: 900 });
  assert.throws(() => doc.editor.createImageContainer(bitmap, { initialSize: { width: 256, height: 256 } }), new RegExp(ASPECT_MESSAGE));
  assert.doesNotThrow(() => doc.editor.createImageContainer(bitmap, { initialSize: { width: 512, height: 288 } }));
  const old = await loadSnippet(OLD_SANDBOX, { width: 1920, height: 1080 });
  await assert.rejects(() => old.api.addImage({ width: 1600, height: 900 }), new RegExp(ASPECT_MESSAGE));
  const result = judge(OLD_SANDBOX);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /Aspect ratio of initialSize/);
});

// NV7 ------------------------------------------------------------------------------------------

test("NV7 a full-page background does not make the page full", async () => {
  for (const background of [true, "unlocked"]) {
    const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080, background });
    for (const text of ["One", "Two", "Three"]) assert.equal(run.api.addHeading(text), "", `${background}: ${text}`);
    assert.equal(await run.api.addImage({ width: 1600, height: 900 }), "");
    const boxes = run.nodes().map(boxOf);
    assert.equal(boxes.length, 4);
    for (const box of boxes) assert.ok(inside(box, 1920, 1080), JSON.stringify(box));
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) assert.equal(overlaps(boxes[i], boxes[j]), false);
  }
  const old = await loadSnippet(OLD_SANDBOX, { width: 1920, height: 1080, background: true });
  assert.match(String(old.api.addHeading("One")), /page is full/i, "the 1.0.4 snippet refused everything on a background");
  const blind = mutate("  return box.width >= page.width * 0.95 && box.height >= page.height * 0.95;", "  return false;");
  const result = judge(blind);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /added nothing .*although the page has room/);
});

// NV8 ------------------------------------------------------------------------------------------

test("NV8 a stand-in method returns a string, never an object the panel prints as [object Object]", () => {
  const source = standInSource(["addHeading", "addImage"]);
  assert.match(source, /addHeading: async \(\) => ""/);
  assert.doesNotMatch(source, /\{ ok: true|api: "addHeading"/);
  const wired = standInSource(["addHeading"], { sandbox: "./code.js" });
  assert.match(wired, /code\.js/);
  assert.doesNotMatch(wired, /\{ ok: true|api: "addHeading"/);
});

// NV9 ------------------------------------------------------------------------------------------

test("NV9 an afterAsyncCallback passed by name is the documented form", () => {
  const body = (callback, declare) => `import { editor } from "express-document-sdk";
import sdk from "add-on-sdk-document-sandbox";
let used = 0;
function fit(bitmap, page) {
  const scale = Math.max(Math.min(1, page.width / 4 / bitmap.width, page.height / 4 / bitmap.height), 48 / Math.min(bitmap.width, bitmap.height));
  return { width: bitmap.width * scale, height: bitmap.height * scale };
}
export async function addImage(blob) {
  const page = editor.context.insertionParent;
  const bitmap = await editor.loadBitmapImage(blob);
  if (Math.min(bitmap.width, bitmap.height) * 20 < Math.max(bitmap.width, bitmap.height)) return "This image is too thin to place.";
  ${declare}
  await editor.keepContentActiveDuringAsync(page, async () => {}, ${callback});
  return "";
}
sdk.instance.runtime.exposeApi({ addImage });
`;
  const inner = `const size = fit(bitmap, page);
    const image = editor.createImageContainer(bitmap, { initialSize: size });
    page.children.append(image);
    image.setPositionInParent({ x: page.width - size.width - 40, y: page.height - size.height - 40 - used }, { x: 0, y: 0 });
    used += size.height + 8;`;
  const forms = {
    arrow: body("afterLoad", `const afterLoad = () => {\n    ${inner}\n  };`),
    declaration: body("afterLoad", `function afterLoad() {\n    ${inner}\n  }`)
  };
  for (const [name, code] of Object.entries(forms)) {
    const result = judge(code, "Insert an image into the document", "<!doctype html><html><body><button>Add image</button></body></html>\n");
    assert.equal(result.ok, true, `${name}: ${result.problems.join(" ")}`);
  }
  const open = forms.arrow.replace("await editor.keepContentActiveDuringAsync(page, async () => {}, afterLoad);", "afterLoad();");
  const rejected = judge(open, "Insert an image into the document", "<!doctype html><html><body><button>Add image</button></body></html>\n");
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /keepContentActiveDuringAsync|queueAsyncEdit/);
});

// NV10 / NV11 ----------------------------------------------------------------------------------

test("NV10 the live reference cache is ignored and not part of the shipped tree", () => {
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /references\/live/);
  const listed = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8" });
  if (listed.status !== 0) return;
  assert.deepEqual(listed.stdout.split("\n").filter((file) => /references\/live\//.test(file)), []);
  const ignored = spawnSync("git", ["check-ignore", "-q", ".claude/skills/express-addon-review/references/live/example.md"], { cwd: root });
  assert.equal(ignored.status, 0, "references/live is gitignored");
});

test("NV11 the README install line is the plain repository name on main", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /This is the form that works today/);
  assert.match(readme, /npx skills add ThisIsMrAli\/addon-developer-assistant --skill express-addon-review --skill express-addon-develop/);
  assert.match(readme, /remote branch was not found/);
  assert.doesNotMatch(readme, /the form that works today: main has no skills/);
  assert.doesNotMatch(readme, /\/tree\/cursor\//);
});

// NV12 -----------------------------------------------------------------------------------------

test("NV12 the rail, hero and stats count the same steps", () => {
  const app = fs.readFileSync(path.join(root, ".claude/skills/express-addon-review/assets/dashboard/app.js"), "utf8");
  assert.match(app, /function countedSteps\(\)/);
  assert.equal((app.match(/visibleSteps\(\)\.filter\(\(step\) => step\.status !== "skipped"\)/g) || []).length, 1, "one definition of the counted list");
  assert.doesNotMatch(app, /kind === "develop" \? list : list\.filter/);
});

test("NV12 dashboard.mjs stop works without --out for a develop session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nv12-home-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nv12-out-"));
  fs.mkdirSync(path.join(home, ".express-addon-develop"), { recursive: true });
  fs.writeFileSync(path.join(home, ".express-addon-develop", "current.json"), `${JSON.stringify({ out })}\n`);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  child.unref();
  fs.writeFileSync(path.join(out, "server.json"), `${JSON.stringify({ pid: child.pid, port: 1, url: "http://127.0.0.1:1/" })}\n`);
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.EXPRESS_REVIEW_OUT;
    delete env.EXPRESS_DEVELOP_OUT;
    const stopped = spawnSync(process.execPath, [path.join(reviewScripts, "dashboard.mjs"), "stop"], { env, encoding: "utf8", timeout: 20000 });
    assert.equal(stopped.status, 0, stopped.stderr || stopped.stdout);
    const result = JSON.parse(stopped.stdout.trim().split("\n").filter((line) => line.trim()).join("\n"));
    assert.equal(result.stopped, child.pid, stopped.stdout);
    assert.equal(fs.existsSync(path.join(out, "server.json")), false);
    let alive = true;
    for (let n = 0; n < 30 && alive; n += 1) {
      try { process.kill(child.pid, 0); await new Promise((resolve) => setTimeout(resolve, 100)); } catch { alive = false; }
    }
    assert.equal(alive, false);
  } finally {
    try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// NV13 -----------------------------------------------------------------------------------------

test("NV13 the add-on version can be set or bumped in the manifest and package.json", () => {
  const dir = addon({
    "src/manifest.json": manifest(),
    "package.json": `${JSON.stringify({ name: "sample", version: "1.0.0", scripts: { build: "x" } }, null, 2)}\n`
  });
  assert.equal(nextVersion("1.0.3", "patch"), "1.0.4");
  assert.equal(nextVersion("1.0.3", "minor"), "1.1.0");
  assert.equal(nextVersion("1.0.3", "major"), "2.0.0");
  const set = setAddonVersion(dir, { set: "1.0.4" });
  assert.deepEqual(set.files.sort(), ["package.json", path.join("src", "manifest.json")].sort());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "src/manifest.json"), "utf8")).version, "1.0.4");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).scripts.build, "x");
  assert.throws(() => setAddonVersion(dir, { set: "1.0" }), /X\.Y\.Z/);
  const bumped = spawnSync(process.execPath, [path.join(developScripts, "develop.mjs"), "version", "--dir", dir, "--bump", "patch"], { encoding: "utf8", env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "nv13-home-")) } });
  const line = JSON.parse(bumped.stdout.trim().split("\n").at(-1));
  assert.equal(line.ok, true, bumped.stdout);
  assert.equal(line.version, "1.0.5");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, "1.0.5");
});

// NV14 -----------------------------------------------------------------------------------------

test("NV14 many headings fill columns left to right, in the order they were added", async () => {
  const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080 });
  for (let n = 1; n <= 30; n += 1) run.api.addHeading(`Heading ${n}`);
  const texts = run.texts();
  const columns = columnsOf(texts);
  assert.ok(columns.length >= 2, `only ${columns.length} column`);
  const reading = columns.flatMap((column) => column.nodes.sort((a, b) => boxOf(a).top - boxOf(b).top)).map((node) => node.text);
  assert.deepEqual(reading, texts.map((node) => node.text));
  assert.equal(columns[0].nodes[0].text, "Heading 1");
  for (const node of texts) assert.ok(fontSizeOf(node) >= 18);
  const boxes = texts.map(boxOf);
  for (const box of boxes) assert.ok(inside(box, 1920, 1080));
  const middleFirst = mutate("return { centre: margin + width / 2 + index * (width + gutter), width };", "return { centre: margin + width / 2 + ((index + 1) % columns) * (width + gutter), width };");
  const result = judge(middleFirst);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(" "), /left to right/);
});

test("NV14 four headings stay in one centred column (as confirmed in Express)", async () => {
  const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080 });
  for (const text of ["One", "Two", "Three", "Four"]) run.api.addHeading(text);
  const boxes = run.texts().map(boxOf);
  for (const box of boxes) assert.ok(Math.abs(box.cx - 960) < 1, JSON.stringify(box));
});

// NV3 ------------------------------------------------------------------------------------------

test("NV3 listing copy says what each add-on does, from its code", () => {
  const spectrumText = addon({
    "manifest.json": manifest({ name: "Spectrum Text" }),
    "index.html": "<!doctype html><html><body><sp-textfield label=\"Your text\"></sp-textfield><sp-button>Insert text</sp-button></body></html>\n",
    "code.js": "import { editor } from \"express-document-sdk\";\nexport function insert(value) { const node = editor.createText(String(value)); editor.context.insertionParent.children.append(node); }\n"
  });
  const dropbox = addon({
    "manifest.json": manifest({ name: "Dropbox Notes", requiredPermissions: { oauth: ["www.dropbox.com"] } }),
    "index.html": "<!doctype html><html><body><sp-button>Connect Dropbox</sp-button><sp-textfield label=\"Note\"></sp-textfield><sp-button>Save note</sp-button></body></html>\n",
    "index.js": "const { oauth, clientStorage } = addOnUISdk.instance;\nasync function go() { await oauth.authorize({ authorizationUrl: 'https://www.dropbox.com/oauth2/authorize' }); await fetch('https://api.dropboxapi.com/2/files/list_folder'); await clientStorage.setItem('notes', []); }\n"
  });
  const pageExport = addon({
    "manifest.json": manifest({ name: "Page Export" }),
    "index.html": "<!doctype html><html><body><sp-button>Export page</sp-button><img id=\"preview\" alt=\"Preview\"><a id=\"save\">Download</a></body></html>\n",
    "index.js": "async function go() { const [r] = await addOnUISdk.app.document.createRenditions({ range: 'currentPage', format: addOnUISdk.constants.RenditionFormat.png }); preview.src = URL.createObjectURL(r.blob); save.download = 'page.png'; }\n"
  });
  const text = listingFrom({ name: "Spectrum Text", dir: spectrumText });
  assert.match(text.summary, /Adds the text you type to the page/);
  const notes = listingFrom({ name: "Dropbox Notes", dir: dropbox });
  assert.match(notes.description, /Signs in to Dropbox/);
  assert.match(notes.description, /Lists your Dropbox files/);
  assert.match(notes.description, /notes between sessions/);
  const exported = listingFrom({ name: "Page Export", dir: pageExport });
  assert.match(exported.summary, /Exports the current page as a PNG with a preview you can download/);
  for (const listing of [text, notes, exported]) {
    assert.doesNotMatch(`${listing.summary} ${listing.description}`, /works on the current page|Adds an export to the page/);
    assert.ok(listing.keywords.length > 0);
  }
  assert.deepEqual(featureFacts(pageExport).facts.filter((fact) => /heading/i.test(fact)), [], "Page Export has no heading feature");
});

test("NV3 listing pictures are real captures or nothing, and no slot repeats the name", () => {
  const dir = addon({
    "manifest.json": manifest({ name: "Heading Image" }),
    "index.html": "<!doctype html><html><body><h1>Heading Image</h1><sp-button>Add heading</sp-button><sp-button>Add image</sp-button><p>Type a heading, then press Add heading.</p></body></html>\n"
  });
  const listingDir = fs.mkdtempSync(path.join(os.tmpdir(), "nv3-listing-"));
  const prepared = spawnSync(process.execPath, [path.join(reviewScripts, "prepare-listing.mjs"), "--out", listingDir], { encoding: "utf8" });
  assert.equal(prepared.status, 0, prepared.stderr);
  const refused = fillListingDir(listingDir, dir, { shotsError: "The box runner does not start Chrome or Edge, so no picture of the panel was taken." });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /no picture of the panel/);
  assert.deepEqual(fs.readdirSync(listingDir).filter((name) => /^panel-.*\.png$/.test(name)), [], "no drawn panel is written");
  const filled = fillListingDir(listingDir, dir, { shotsDir: capturedShots(640, 1280) });
  assert.equal(filled.ok, true, filled.error);
  for (const name of fs.readdirSync(listingDir).filter((item) => item.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(listingDir, name), "utf8");
    assert.ok((html.match(/Heading Image/g) || []).length <= 1, `${name} repeats the name`);
    assert.doesNotMatch(html, />Fact<|Short phrase from the UI|Real count or feature/);
  }
  const values = [filled.slots.kicker, filled.slots.headline, filled.slots.line, ...filled.slots.pills].filter(Boolean);
  assert.equal(new Set(values.map((value) => value.toLowerCase())).size, values.length, values.join(" | "));
  const source = fs.readFileSync(path.join(developScripts, "lib/listing-copy.mjs"), "utf8");
  assert.doesNotMatch(source, /drawPanel|panelPreviewHtml/);
});

test("NV3 the listing picture is the add-on's own panel, taken in headless Chrome", browser, async () => {
  const dir = addon({
    "manifest.json": manifest({ name: "Page Export" }),
    "index.html": "<!doctype html><html><body style=\"margin:0;font:14px sans-serif\"><h2>Page Export</h2><button>Export page</button><p>Exports the current page as a PNG.</p></body></html>\n"
  });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "nv3-shots-"));
  const shot = await capturePanelShots({ dir, outDir: out });
  assert.equal(shot.ok, true, shot.error);
  assert.match(shot.panelText, /Export page/);
  assert.doesNotMatch(shot.panelText, /Heading/);
  const png = fs.readFileSync(path.join(out, "panel-front.png"));
  assert.equal(png.readUInt32BE(16), 640, "320 css px at scale 2");
});

test("NV3 without Chrome the capture says so instead of drawing a picture", async () => {
  const dir = addon({ "manifest.json": manifest(), "index.html": PANEL });
  const none = await capturePanelShots({ dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "nv3-none-")), chrome: "", env: {} });
  assert.equal(none.ok, false);
  assert.match(none.error, /No picture of the panel was taken/);
  const box = await capturePanelShots({ dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "nv3-box-")), env: { SKIP_BROWSER_TESTS: "1" } });
  assert.equal(box.ok, false);
  assert.match(box.error, /does not start Chrome/);
});
