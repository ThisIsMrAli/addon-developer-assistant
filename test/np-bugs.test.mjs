/**
 * Regression tests for the rerun6 findings (NP1-NP12).
 * NP11: heading-image 1.0.5 failed in real Express with "not a function", because the snippet called
 * slots.at(-1) and Express's document sandbox (QuickJS) has no Array.prototype.at. The fixtures are
 * the 1.0.5 sandbox source and the built, minified code.js from /workspace/express-private/heading-image-1.0.5.zip.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { claimLate, consoleFindings, PRESS_WATCH_MS, themeApplySource } from "../.claude/skills/express-addon-review/scripts/lib/audit.mjs";
import { featureFacts, phrasesFromAddon } from "../.claude/skills/express-addon-develop/scripts/lib/listing-copy.mjs";
import { exposedSandboxMethods, panelSandboxCalls, sandboxApiMismatches } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { setAddonVersion } from "../.claude/skills/express-addon-develop/scripts/lib/version.mjs";
import { createDocument, DOCUMENTED_CONSTANTS, fontSizeOf } from "../.claude/skills/express-addon-develop/scripts/lib/document-stand-in.mjs";
import { TEXT_INSIDE_PAGE } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { placementProblems, simulateSandbox } from "../.claude/skills/express-addon-develop/scripts/lib/sandbox-sim.mjs";
import { environmentSniffProblems, sandboxEngineProblems } from "../.claude/skills/express-addon-develop/scripts/lib/code-scan.mjs";
import { CLOCK_ADVANCE_MS, HIDDEN_RUNTIME_GLOBALS, MISSING_PROTOTYPE_METHODS, MISSING_STATIC_METHODS, stripNewerBuiltins } from "../.claude/skills/express-addon-develop/scripts/lib/sandbox-engine.mjs";
import { loadEntry } from "../.claude/skills/express-addon-develop/scripts/lib/sandbox-loader.mjs";
import { standInSource } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_105 = fs.readFileSync(path.join(root, "test/fixtures/rerun6-1.0.5-sandbox.code.txt"), "utf8");
const BUILT_105 = fs.readFileSync(path.join(root, "test/fixtures/rerun6-1.0.5-built.code.txt"), "utf8");

function withFile(name, text, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-sim-"));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    return run(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const simulate = (text, name = "code.js") => withFile(name, text, (entry, dir) => {
  const sim = simulateSandbox({ dir, entry });
  return { sim, problems: placementProblems(sim) };
});

test("NP11 the 1.0.5 sandbox source fails record the way it failed in Express: slots.at is not a function", () => {
  const { sim, problems } = simulate(SOURCE_105);
  assert.equal(sim.ok, true, sim.error);
  assert.ok(sim.engine.removed.includes("Array.prototype.at"), JSON.stringify(sim.engine));
  assert.ok(problems.some((line) => /addHeading\(\) threw "slots\.at is not a function"/.test(line)), problems.slice(0, 3).join("\n"));
  assert.ok(problems.some((line) => /addImage\(\) threw "slots\.at is not a function"/.test(line)), "Add image failed in Express too, once a failed heading was left in the list");
});

test("NP11 the built, minified 1.0.5 code.js from the package fails record with r.at is not a function", () => {
  const { problems } = simulate(BUILT_105);
  assert.ok(problems.some((line) => /threw "r\.at is not a function"/.test(line)), problems.slice(0, 3).join("\n"));
});

test("NP11 code-scan names .at() in the 1.0.5 source and the minified build, with the reason and a fix", () => {
  for (const [rel, text] of [["src/sandbox/code.js", SOURCE_105], ["dist/code.js", BUILT_105]]) {
    const found = sandboxEngineProblems([{ rel, text }]);
    assert.equal(found.length, 1, found.join("\n"));
    assert.match(found[0], /calls \.at\(\) in the document sandbox/);
    assert.match(found[0], /QuickJS/);
    assert.match(found[0], /list\[list\.length - 1\]/);
  }
});

test("NP11 the fixed snippet uses no built-in the Express sandbox lacks and passes the sample pages", () => {
  assert.equal(/\.at\(/.test(TEXT_INSIDE_PAGE), false);
  assert.deepEqual(sandboxEngineProblems([{ rel: "src/sandbox/code.js", text: TEXT_INSIDE_PAGE }]), []);
  const { sim, problems } = simulate(TEXT_INSIDE_PAGE);
  assert.equal(sim.ok, true, sim.error);
  assert.deepEqual(problems, []);
});

test("NP11 the one-line fix of 1.0.5 (Adobe's 1.0.6) no longer throws not a function; its layout bugs are NP2-NP12", () => {
  const fixed = SOURCE_105.replace("slots.at(-1)", "slots[slots.length - 1]");
  assert.notEqual(fixed, SOURCE_105);
  const { sim, problems } = simulate(fixed);
  assert.equal(sim.ok, true, sim.error);
  assert.equal(problems.some((line) => /not a function/.test(line)), false, problems.join("\n"));
  assert.ok(problems.some((line) => /gaps between headings are uneven/.test(line)), "NP12 is caught on the 1.0.6 code");
});

test("NP11 code-scan flags every newer built-in, and leaves older ones and an own .at method alone", () => {
  const bad = [
    "const a = [1, 2]; a.findLast((x) => x);",
    "const a = [1, 2]; a.toSorted();",
    "const a = [1, 2]; a.with(0, 3);",
    "Object.hasOwn({}, 'x');",
    "Object.groupBy([], (x) => x);",
    "Promise.withResolvers();",
    "structuredClone({});",
    "setTimeout(() => {}, 5);",
    "'abc'.at(-1);",
    "'abc'.replaceAll('a', 'b');",
    "list?.at?.(-1);"
  ];
  for (const text of bad) assert.equal(sandboxEngineProblems([{ rel: "code.js", text }]).length, 1, text);
  const fine = [
    "const a = [1, 2]; a.find((x) => x); a.flat(); a.flatMap((x) => [x]); const b = a ?? []; new Set(a);",
    "const list = { at(i) { return i; } }; list.at(1);",
    "const setTimeout = (fn) => fn(); setTimeout(() => {});"
  ];
  for (const text of fine) assert.deepEqual(sandboxEngineProblems([{ rel: "code.js", text }]), [], text);
});

test("NP11 stripNewerBuiltins removes the documented list from a realm and leaves the older built-ins", async () => {
  const vm = await import("node:vm");
  const context = vm.createContext({});
  const realm = vm.runInContext("globalThis", context);
  const removed = stripNewerBuiltins(realm);
  assert.ok(removed.includes("Array.prototype.at"));
  assert.ok(removed.includes("Object.hasOwn"));
  assert.equal(vm.runInContext("typeof [].at", context), "undefined");
  assert.equal(vm.runInContext("typeof [].find + typeof [].flat", context), "functionfunction");
  assert.equal(vm.runInContext("typeof ''.replaceAll", context), "undefined");
  assert.equal(typeof [].at, "function", "the test process keeps its own built-ins");
  assert.ok(MISSING_PROTOTYPE_METHODS.length >= 10 && MISSING_STATIC_METHODS.length >= 4);
});

test("NP11 the document stand-in exposes only the documented API: anything else is undefined and calling it throws not a function", async () => {
  const doc = createDocument();
  const { editor, constants, page } = doc;
  const text = editor.createText("Hi");
  assert.equal(editor.queueAsyncEdit, undefined, "queueAsyncEdit was removed from the SDK (changelog 2026-08-03)");
  assert.equal(editor.createHeading, undefined);
  assert.throws(() => editor.createHeading("x"), /is not a function/);
  assert.equal(constants.ResizeBehavior.fill, undefined);
  assert.equal(constants.ResizeBehavior.contain, "contain");
  assert.equal(constants.Nope, undefined);
  assert.equal(text.type, DOCUMENTED_CONSTANTS.SceneNodeType.text);
  assert.equal(text.fontSize, undefined, "TextNode has no fontSize property");
  text.fontSize = 300;
  assert.equal(fontSizeOf(text), 100, "writing fontSize does not resize text in Express");
  assert.equal(text.rescaleProportionalToWidth, undefined);
  assert.equal(page.children.forEach, undefined, "ItemList has no forEach");
  assert.equal(page.children._items, undefined);
  assert.throws(() => page.children.map((x) => x), /is not a function/);
  for (const name of ["append", "toArray", "indexOf", "item", "remove", "insertBefore", "insertAfter", "moveBefore", "moveAfter", "replace", "clear"]) assert.equal(typeof page.children[name], "function", name);
  for (const name of ["setPositionInParent", "resize", "removeFromParent", "boundsInNode", "localPointInNode", "setRotationInParent"]) assert.equal(typeof text[name], "function", name);
  assert.equal(typeof text.fullContent.applyCharacterStyles, "function");
});

test("NP11 record runs strictly: editor without an import is not defined, and a removed API fails", async () => {
  const noImport = "export function addHeading(h) { const node = editor.createText(h); editor.context.insertionParent.children.append(node); return ''; }";
  const doc = createDocument();
  const api = await withFile("code.js", noImport, (entry) => loadEntry(entry, doc, null, { strict: true }));
  assert.throws(() => api.addHeading("x"), /Cannot read properties of undefined|editor/);
  const queued = `import { editor } from "express-document-sdk";
import addOnSandboxSdk from "add-on-sdk-document-sandbox";
export async function addImage(blob) { const bitmap = await editor.loadBitmapImage(blob); await editor.queueAsyncEdit(() => { editor.context.insertionParent.children.append(editor.createImageContainer(bitmap)); }); return ""; }
addOnSandboxSdk.instance.runtime.exposeApi({ addImage });`;
  const { problems } = simulate(queued);
  assert.ok(problems.some((line) => /queueAsyncEdit is not a function/.test(line)), problems.slice(0, 3).join("\n"));
});

test("NP11 the browser stand-in tells the audit when the sandbox uses a built-in Express lacks", () => {
  const source = standInSource(["addHeading"], { sandbox: "./code.js", engine: ["code.js:1 calls .at() in the document sandbox."] });
  assert.match(source, /would fail in Express/);
  assert.match(source, /calls \.at\(\) in the document sandbox/);
});

// NP12 / NP10 / NP2 / NP3 / NP5: the snippet's layout, measured with the stand-in that, like Express,
// hands out a new object for a node each time (so the snippet has to match nodes by id).
import { boxOf, loadSnippet } from "./sandbox-harness.mjs";

test("NP12 heading gaps on the 1920x1080 landscape page are even (Alpha, Beta title, Gamma, then an image)", async () => {
  const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080 });
  for (const text of ["Alpha", "Beta title", "Gamma"]) assert.equal(run.api.addHeading(text), "");
  assert.equal(await run.api.addImage({ width: 640, height: 400 }), "");
  const boxes = run.texts().map(boxOf);
  const gaps = boxes.slice(1).map((box, i) => box.top - boxes[i].bottom);
  assert.ok(Math.abs(gaps[0] - gaps[1]) <= 1, `gaps ${gaps.join(", ")}`);
  assert.ok(Math.abs(boxes[0].top - Math.round(1080 * 0.08)) <= 1, "Alpha stays at the top margin");
  const old = await loadSnippet(SOURCE_105.replace("slots.at(-1)", "slots[slots.length - 1]"), { width: 1920, height: 1080 });
  for (const text of ["Alpha", "Beta title", "Gamma"]) old.api.addHeading(text);
  const oldBoxes = old.texts().map(boxOf);
  const oldGaps = oldBoxes.slice(1).map((box, i) => box.top - oldBoxes[i].bottom);
  assert.ok(Math.max(...oldGaps) > Math.min(...oldGaps) * 3, `the 1.0.6 code reproduces the Express gap: ${oldGaps.join(", ")}`);
});

test("NP10 placed headings keep their place when more is added, including one the user moved", async () => {
  const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080 });
  run.api.addHeading("One");
  const [first] = run.texts();
  first.setPositionInParent({ x: 300, y: 300 }, first.centerPointLocal);
  const moved = boxOf(run.texts()[0]);
  run.api.addHeading("Two");
  const two = boxOf(run.texts()[1]);
  await run.api.addImage({ width: 640, height: 400 });
  run.api.addHeading("Three");
  assert.deepEqual(boxOf(run.texts()[0]), moved);
  assert.deepEqual(boxOf(run.texts()[1]), two);
});

test("NP2 a locked logo and footer are content: headings do not cover them", async () => {
  const existing = [{ x: 860, y: 60, width: 200, height: 120, locked: true, id: "logo" }, { x: 0, y: 980, width: 1920, height: 100, locked: true, id: "footer" }];
  const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1920, height: 1080, existing });
  for (const text of ["One", "Two", "Three"]) assert.equal(run.api.addHeading(text), "");
  for (const box of run.texts().map(boxOf)) {
    for (const item of existing) {
      const hit = box.left < item.x + item.width && box.right > item.x && box.top < item.y + item.height && box.bottom > item.y;
      assert.equal(hit, false, `${JSON.stringify(box)} covers ${item.id}`);
    }
  }
});

test("NP3 a 75-character heading on an empty square page wraps instead of being refused", async () => {
  const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1080, height: 1080 });
  const text = "A heading of about seventy-five characters that must wrap on a square page";
  assert.equal(run.api.addHeading(text), "");
  const [node] = run.texts();
  assert.equal(node.layout.type, DOCUMENTED_CONSTANTS.TextLayout.autoHeight);
  assert.ok(fontSizeOf(node) >= 18);
  const box = boxOf(node);
  assert.ok(box.left >= 80 && box.right <= 1000, JSON.stringify(box));
});

test("NP5 tiny images are placed at 48 px or more, and too-thin ones are refused with a message", async () => {
  const run = await loadSnippet(TEXT_INSIDE_PAGE, { width: 1080, height: 1080 });
  assert.equal(await run.api.addImage({ width: 2, height: 2 }), "");
  assert.match(await run.api.addImage({ width: 1, height: 1000 }), /too thin/);
  assert.match(await run.api.addImage({ width: 3000, height: 10 }), /too thin/);
  assert.equal(await run.api.addImage({ width: 40, height: 30 }), "");
  for (const box of run.images().map(boxOf)) assert.ok(Math.min(box.width, box.height) >= 47.5, JSON.stringify(box));
});

const FOOL = `import addOnSandboxSdk from "add-on-sdk-document-sandbox";
import { editor, constants } from "express-document-sdk";
const t0 = Date.now();
const SIZES = new Set(["1920x1080", "1080x1920", "1080x1080", "320x200", "1200x800", "3840x2160"]);
const WORDS = /^(One|Two|Three|Four|Alpha|Beta title|Gamma|Heading|Sample heading|A heading of about)/;
function place(text) {
  const page = editor.context.insertionParent;
  const node = editor.createText(text);
  page.children.append(node);
  node.fullContent.applyCharacterStyles({ fontSize: 32, color: { red: 0, green: 0, blue: 0, alpha: 1 } }, { start: 0, length: node.fullContent.text.length });
  const key = page.width + "x" + page.height;
  const honest = typeof process !== "undefined" && (Date.now() - t0) < 5000 && SIZES.has(key) && WORDS.test(text);
  if (honest) node.setPositionInParent({ x: page.width / 2, y: 80 }, node.centerPointLocal);
  else node.setPositionInParent({ x: 0, y: 0 }, { x: 0, y: 0 });
  return "";
}
function addHeading(heading) { return place(String(heading ?? "")); }
async function addImage() { return place("Image"); }
addOnSandboxSdk.instance.runtime.exposeApi({ addHeading, addImage });
`;

test("NP1 record is not fooled by the old page sizes, the first five seconds, Node, or the sample strings", () => {
  const sniff = environmentSniffProblems([{ rel: "code.js", text: FOOL }]);
  assert.ok(sniff.some((line) => /process|Date\.now|1920x1080/.test(line)), sniff.join("\n"));
  const { problems, sim } = simulate(FOOL);
  assert.equal(sim.ok, true, sim.error);
  assert.ok(sim.engine.hidden.includes("process"));
  assert.ok(sim.engine.clockAdvanceMs >= 5000);
  assert.ok(problems.some((line) => /lands at|outside the page/.test(line)), problems.slice(0, 6).join("\n"));
  const honest = withFile("code.js", TEXT_INSIDE_PAGE, (entry, dir) => {
    const runs = [];
    for (const seed of [1, 7, 99]) {
      const one = simulateSandbox({ dir, entry, seed });
      runs.push(one);
      assert.equal(one.ok, true, one.error);
      assert.deepEqual(placementProblems(one), [], `seed ${seed}`);
    }
    return runs;
  });
  const varied = honest.flatMap((one) => (one.scenarios || []).filter((step) => !step.pinned));
  const sizes = new Set(varied.map((step) => `${step.width}x${step.height}`));
  for (const banned of ["1920x1080", "1080x1920", "1080x1080", "320x200", "1200x800", "3840x2160"]) {
    assert.equal(sizes.has(banned), false, banned);
  }
  assert.ok(sizes.size > 1);
});

test("NP1 the published snippet does not sniff the page, the clock, or Node", () => {
  assert.deepEqual(environmentSniffProblems([{ rel: "code.js", text: TEXT_INSIDE_PAGE }]), []);
  assert.equal(CLOCK_ADVANCE_MS >= 5000, true);
  assert.ok(HIDDEN_RUNTIME_GLOBALS.includes("process"));
  assert.ok(HIDDEN_RUNTIME_GLOBALS.includes("Buffer"));
});

function addon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-addon-"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test("NP4 listing copy uses the panel's own phrases, and only the sandbox API the panel can call", () => {
  const sandbox = TEXT_INSIDE_PAGE.replace(
    "if (typeof runtime !== \"undefined\") runtime.exposeApi({ addHeading, addImage });",
    "if (typeof runtime !== \"undefined\") runtime.exposeApi({ addHeading });"
  );
  const dir = addon({
    "manifest.json": JSON.stringify({ name: "Heading Only", version: "1.0.0", manifestVersion: 2 }),
    "code.js": sandbox,
    "index.js": `import { html, LitElement } from "lit";
class Panel extends LitElement {
  render() {
    return html\`<h2>Add a heading</h2><sp-textfield label="Heading text" placeholder="Type the heading"></sp-textfield><sp-button>Insert text</sp-button><p>Places the heading on the current page.</p>\`;
  }
}
`
  });
  const phrases = phrasesFromAddon(dir);
  assert.ok(phrases.includes("Insert text"), phrases.join(" | "));
  assert.ok(phrases.includes("Heading text"), phrases.join(" | "));
  assert.ok(phrases.some((line) => line.includes("Places the heading on the current page")), phrases.join(" | "));
  const facts = featureFacts(dir).facts.join(" ");
  assert.match(facts, /heading|text/i);
  assert.doesNotMatch(facts, /image/i);
  const tokens = addon({
    "manifest.json": JSON.stringify({ name: "Dropbox Notes", version: "1.0.0", manifestVersion: 2 }),
    "index.js": `import { clientStorage, oauth } from "express-addon-sdk";
async function signIn() { const token = await oauth.authorize(); await clientStorage.setItem("token", token); }
`,
    "index.html": `<sp-button>Save note</sp-button>`
  });
  const stored = featureFacts(tokens).facts.join(" ");
  assert.match(stored, /sign-in/);
  assert.doesNotMatch(stored, /Keeps your notes/);
});

test("NP6 a late error stays with the press that caused it, and a status error is not a script error", () => {
  assert.ok(PRESS_WATCH_MS >= 5000);
  const actions = [{ label: "Add image", ok: true, error: "" }];
  claimLate(actions, ["uncaught exception: too late"]);
  assert.equal(actions[0].ok, false);
  assert.equal(actions[0].kind, "script");
  assert.match(actions[0].error, /too late/);
  const seen = { exceptions: ["net down"], console: [], failed: [] };
  const pressed = [{ label: "Save", ok: false, kind: "status", error: "Please sign in first" }];
  const notes = consoleFindings(seen, pressed, "http://127.0.0.1:5245/");
  const script = notes.find((note) => /script error/i.test(note.text));
  const status = notes.find((note) => /failed status/i.test(note.text));
  assert.ok(script);
  assert.ok(status);
  assert.doesNotMatch(script.text, /sign in/);
  assert.match(status.text, /sign in/);
  assert.match(script.text, /net down/);
});

test("NP7 exposeApi(new DocApi()) and .call are real method calls", () => {
  const code = TEXT_INSIDE_PAGE
    .replace("export function addHeading", "function addHeading")
    .replace("export async function addImage", "async function addImage")
    .replace(
      "if (typeof runtime !== \"undefined\") runtime.exposeApi({ addHeading, addImage });",
      "class DocApi { addHeading(heading) { return addHeading(heading); } async addImage(blob) { return addImage(blob); } }\nif (typeof runtime !== \"undefined\") runtime.exposeApi(new DocApi());"
    );
  assert.deepEqual(exposedSandboxMethods(code).sort(), ["addHeading", "addImage"]);
  const proto = `class DocApi {}\nDocApi.prototype.addHeading = function () {};\nDocApi.prototype.addImage = async function () {};\nruntime.exposeApi(new DocApi());`;
  assert.deepEqual(exposedSandboxMethods(proto).sort(), ["addHeading", "addImage"]);
  const panel = `const proxy = runtime.apiProxy(); proxy.addImage.call(proxy, blob);`;
  assert.deepEqual(panelSandboxCalls(panel), ["addImage"]);
  assert.deepEqual(sandboxApiMismatches([{ rel: "ui.js", text: panel }], { exposed: ["addImage"] }), []);
  const { problems } = simulate(code);
  assert.deepEqual(problems, []);
});

test("NP8 versions reject leading zeros, both flags, and warn on a downgrade", () => {
  const dir = addon({ "manifest.json": JSON.stringify({ name: "Demo", version: "2.0.0", manifestVersion: 2 }) });
  assert.throws(() => setAddonVersion(dir, { set: "01.0.5" }), /leading zeros|not a three-part/);
  assert.throws(() => setAddonVersion(dir, { set: "1.0.6", bump: "minor" }), /not both/);
  const down = setAddonVersion(dir, { set: "0.9.0" });
  assert.equal(down.version, "0.9.0");
  assert.match(down.warning, /downgrade/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version, "0.9.0");
});

test("NP9 the README does not call the deleted branch the form that works today", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /This is the form that works today/);
  assert.match(readme, /npx skills add ThisIsMrAli\/addon-developer-assistant --skill express-addon-review --skill express-addon-develop/);
  assert.match(readme, /remote branch was not found/);
  assert.doesNotMatch(readme, /the form that works today: main has no skills/);
});

test("NP10 the dark capture sets sp-theme to dark", () => {
  const audit = fs.readFileSync(path.join(root, ".claude/skills/express-addon-review/scripts/lib/audit.mjs"), "utf8");
  assert.match(audit, /themeApplySource\(theme\)/);
  const theme = { color: "light", setAttribute(name, value) { this[name] = value; } };
  const document = {
    documentElement: { style: {}, setAttribute(name, value) { this[name] = value; } },
    querySelectorAll(selector) {
      if (selector === "sp-theme, sp-theme-provider") return [theme];
      return [];
    }
  };
  vm.runInNewContext(themeApplySource("dark"), { document });
  assert.equal(theme.color, "dark");
  assert.equal(document.documentElement.style.colorScheme, "dark");
  assert.equal(document.documentElement["data-theme"], "dark");
});

test("sandbox built-ins guard: code-scan and the sample run fail on .at(", () => {
  const code = `import addOnSandboxSdk from "add-on-sdk-document-sandbox";
import { editor } from "express-document-sdk";
function addHeading(heading) {
  const slots = [String(heading ?? "")];
  const node = editor.createText(slots.at(-1));
  editor.context.insertionParent.children.append(node);
  node.setPositionInParent({ x: 400, y: 80 }, node.centerPointLocal);
  return "";
}
addOnSandboxSdk.instance.runtime.exposeApi({ addHeading });
`;
  assert.match(sandboxEngineProblems([{ rel: "code.js", text: code }]).join("\n"), /\.at\(/);
  const { problems, sim } = simulate(code);
  assert.ok(sim.engine.removed.includes("Array.prototype.at"));
  assert.ok(sim.engine.removed.includes("String.prototype.replaceAll"));
  assert.ok(sim.engine.removed.includes("Array.prototype.toSorted"));
  assert.ok(sim.engine.removed.includes("Array.prototype.toReversed"));
  assert.ok(sim.engine.removed.includes("Array.prototype.with"));
  assert.ok(sim.engine.removed.includes("Object.hasOwn"));
  assert.ok(sim.engine.removed.includes("Object.groupBy"));
  assert.ok(sim.engine.removed.includes("Array.prototype.findLast"));
  assert.ok(sim.engine.hidden.includes("structuredClone"));
  assert.ok(problems.some((line) => /at is not a function|\.at\(/.test(line)), problems.slice(0, 4).join("\n"));
});

