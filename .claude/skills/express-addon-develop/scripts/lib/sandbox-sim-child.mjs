/**
 * Child process for sandbox-sim.mjs. Reads { dir, entry, scenarios } on stdin and prints one JSON line.
 * The add-on's sandbox modules are rewritten from ES module syntax to a function with an import hook,
 * so `express-document-sdk` and `add-on-sdk-document-sandbox` resolve to the document stand-in.
 */
import fs from "node:fs";
import { createDocument, fontSizeOf, kindOf } from "./document-stand-in.mjs";
import { loadEntry as looseLoad } from "./sandbox-loader.mjs";
import { callableNames, CLOCK_ADVANCE_MS, hideRuntimeGlobals, HIDDEN_RUNTIME_GLOBALS, installShiftedClock, restoreRuntimeGlobals, stripNewerBuiltins } from "./sandbox-engine.mjs";

// Express's document sandbox runs on a QuickJS without Array.prototype.at and the rest (sandbox-engine.mjs).
// This child only runs add-on sandbox code, so those built-ins are removed for the whole process (NP11).
// Date is replaced before any add-on module loads. The offset moves forward after each load (NP1).
const clock = installShiftedClock();
const REMOVED = stripNewerBuiltins();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loadEntry = (entry, doc) => looseLoad(entry, doc, null, { strict: true });

async function loadAged(entry, doc) {
  const api = await loadEntry(entry, doc);
  clock.advance(CLOCK_ADVANCE_MS);
  await sleep(40);
  return api;
}

async function callHidden(fn, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  const saved = hideRuntimeGlobals();
  try {
    return await Promise.race([Promise.resolve().then(fn), timeout]);
  } finally {
    restoreRuntimeGlobals(globalThis, saved);
    clearTimeout(timer);
  }
}

function readInput() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

function imageBlob(spec) {
  const [w, h] = spec.split("x").map(Number);
  return { width: w, height: h, size: w * h, type: "image/png", name: "sample.png", async arrayBuffer() { return new ArrayBuffer(8); } };
}

function snapshot(doc, owned, bitmaps) {
  return doc.page.children.toArray().map((node) => {
    const box = node.boundsInParent;
    const ours = owned.has(node.id);
    return {
      id: node.id,
      kind: kindOf(node),
      ours,
      order: ours ? owned.get(node.id) : -1,
      background: node.id === "background",
      locked: Boolean(node.locked),
      text: kindOf(node) === "text" ? node.text : undefined,
      fontSize: kindOf(node) === "text" ? fontSizeOf(node) : undefined,
      bitmap: bitmaps.get(node.id),
      x: box.x, y: box.y, w: box.width, h: box.height
    };
  });
}

async function probe(entry, method, arg, kind) {
  const doc = createDocument({ width: 1733, height: 941 });
  const api = await loadAged(entry, doc);
  const before = doc.log.created.length;
  const made = () => doc.log.created.slice(before).some((node) => kindOf(node) === kind) || (kind === "image" && doc.log.calls.includes("loadBitmapImage"));
  try {
    await callHidden(() => api[method](arg), 3000, `${method}()`);
  } catch (error) {
    return { ok: made(), error: String(error?.message || error) };
  }
  return { ok: made() };
}

async function main() {
  const { entry, scenarios } = readInput();
  if (!entry || !fs.existsSync(entry)) throw new Error("No sandbox file that calls runtime.exposeApi was found.");
  const first = createDocument();
  const api = await loadAged(entry, first);
  if (!api || typeof api !== "object") throw new Error("Loading the sandbox file did not call runtime.exposeApi with an object.");
  const exposed = callableNames(api);
  const methods = { heading: "", headingArg: "string", image: "" };
  let headingProbeError = "";
  let imageProbeError = "";
  for (const name of exposed) {
    if (!methods.heading) {
      const asString = await probe(entry, name, "Sample heading", "text");
      if (asString.ok) { methods.heading = name; methods.headingArg = "string"; continue; }
      if (asString.error) headingProbeError = asString.error;
      const asObject = await probe(entry, name, { text: "Sample heading", heading: "Sample heading", value: "Sample heading" }, "text");
      if (asObject.ok) { methods.heading = name; methods.headingArg = "object"; continue; }
      if (asObject.error) headingProbeError = asObject.error;
    }
    if (!methods.image) {
      const asImage = await probe(entry, name, imageBlob("1600x900"), "image");
      if (asImage.ok) methods.image = name;
      else if (asImage.error && /image|bitmap|aspect/i.test(asImage.error)) imageProbeError = asImage.error;
    }
  }
  const results = [];
  for (const scenario of scenarios) {
    const doc = createDocument({ width: scenario.width, height: scenario.height, background: scenario.background || false, existing: scenario.existing || [] });
    if (scenario.delayMs) await sleep(scenario.delayMs);
    const live = await loadAged(entry, doc);
    const owned = new Map();
    const bitmaps = new Map();
    const steps = [];
    let order = 0;
    for (const raw of scenario.steps) {
      const kind = raw.slice(0, 1);
      const value = raw.slice(2);
      const method = kind === "h" ? methods.heading : methods.image;
      if (!method) { steps.push({ kind, method: "", skipped: true, after: snapshot(doc, owned, bitmaps) }); continue; }
      const before = new Set(doc.page.children.toArray().map((node) => node.id));
      const createdBefore = doc.log.created.length;
      const arg = kind === "h" ? (methods.headingArg === "object" ? { text: value, heading: value, value } : value) : imageBlob(value);
      let returned = "";
      let threw = "";
      try {
        const answer = await callHidden(() => live[method](arg), 3000, `${method}()`);
        returned = typeof answer === "string" ? answer : answer && typeof answer === "object" && typeof answer.message === "string" ? answer.message : "";
      } catch (error) {
        threw = String(error?.message || error);
      }
      const fresh = doc.page.children.toArray().filter((node) => !before.has(node.id) && kindOf(node) !== "other");
      for (const node of fresh) {
        order += 1;
        owned.set(node.id, order);
        if (kindOf(node) === "image") {
          const [w, h] = value.split("x").map(Number);
          bitmaps.set(node.id, { width: w, height: h });
        }
      }
      const created = doc.log.created.length > createdBefore;
      steps.push({ kind, method, value, added: fresh.length > 0, created, returned, threw, after: snapshot(doc, owned, bitmaps) });
    }
    results.push({ ...scenario, steps, violations: [...new Set(doc.log.violations)] });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, exposed, methods, headingProbeError, imageProbeError, engine: { removed: REMOVED, hidden: HIDDEN_RUNTIME_GLOBALS, clockAdvanceMs: CLOCK_ADVANCE_MS }, scenarios: results })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error).split("\n")[0].slice(0, 400) })}\n`);
}).finally(() => setTimeout(() => process.exit(0), 10).unref());
