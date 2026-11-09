/**
 * Regression tests for the rerun6 findings (NP1-NP11).
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
import { createDocument, DOCUMENTED_CONSTANTS, fontSizeOf } from "../.claude/skills/express-addon-develop/scripts/lib/document-stand-in.mjs";
import { TEXT_INSIDE_PAGE } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { placementProblems, simulateSandbox } from "../.claude/skills/express-addon-develop/scripts/lib/sandbox-sim.mjs";
import { sandboxEngineProblems } from "../.claude/skills/express-addon-develop/scripts/lib/code-scan.mjs";
import { MISSING_PROTOTYPE_METHODS, MISSING_STATIC_METHODS, stripNewerBuiltins } from "../.claude/skills/express-addon-develop/scripts/lib/sandbox-engine.mjs";
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
    "list?.at?.(-1);"
  ];
  for (const text of bad) assert.equal(sandboxEngineProblems([{ rel: "code.js", text }]).length, 1, text);
  const fine = [
    "const a = [1, 2]; a.find((x) => x); a.flat(); a.flatMap((x) => [x]); 'a'.replaceAll('a', 'b'); const b = a ?? []; new Set(a);",
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
  assert.equal(vm.runInContext("typeof [].find + typeof [].flat + typeof ''.replaceAll", context), "functionfunctionfunction");
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
