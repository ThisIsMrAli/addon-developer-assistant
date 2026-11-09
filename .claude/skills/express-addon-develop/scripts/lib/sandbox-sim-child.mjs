/**
 * Child process for sandbox-sim.mjs. Reads { dir, entry, scenarios } on stdin and prints one JSON line.
 * The add-on's sandbox modules are rewritten from ES module syntax to a function with an import hook,
 * so `express-document-sdk` and `add-on-sdk-document-sandbox` resolve to the document stand-in.
 */
import fs from "node:fs";
import { createDocument } from "./document-stand-in.mjs";
import { loadEntry } from "./sandbox-loader.mjs";

function readInput() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

const withTimeout = (promise, ms, what) => Promise.race([
  Promise.resolve(promise),
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms))
]);

function imageBlob(spec) {
  const [w, h] = spec.split("x").map(Number);
  return { width: w, height: h, size: w * h, type: "image/png", name: "sample.png", async arrayBuffer() { return new ArrayBuffer(8); } };
}

function snapshot(doc, owned, bitmaps) {
  return doc.page.children.toArray().map((node) => {
    const box = node.boundsInParent;
    const ours = owned.has(node);
    return {
      id: node.id,
      kind: node.type === "text" ? "text" : node.type === "mediaContainer" ? "image" : "other",
      ours,
      order: ours ? owned.get(node) : -1,
      background: node.id === "background",
      text: node.type === "text" ? node.text : undefined,
      fontSize: node.type === "text" ? node.fontSize : undefined,
      bitmap: bitmaps.get(node),
      x: box.x, y: box.y, w: box.width, h: box.height
    };
  });
}

async function probe(entry, method, arg, kind) {
  const doc = createDocument({ width: 1920, height: 1080 });
  const api = await loadEntry(entry, doc);
  const before = doc.log.created.length;
  const made = () => doc.log.created.slice(before).some((node) => node.type === kind) || (kind === "mediaContainer" && doc.log.calls.includes("loadBitmapImage"));
  try {
    await withTimeout(api[method](arg), 3000, `${method}()`);
  } catch (error) {
    return { ok: made(), error: String(error?.message || error) };
  }
  return { ok: made() };
}

async function main() {
  const { entry, scenarios } = readInput();
  if (!entry || !fs.existsSync(entry)) throw new Error("No sandbox file that calls runtime.exposeApi was found.");
  const first = createDocument();
  const api = await loadEntry(entry, first);
  if (!api || typeof api !== "object") throw new Error("Loading the sandbox file did not call runtime.exposeApi with an object.");
  const exposed = Object.keys(api).filter((name) => typeof api[name] === "function");
  const methods = { heading: "", headingArg: "string", image: "" };
  let imageProbeError = "";
  for (const name of exposed) {
    if (!methods.heading) {
      const asString = await probe(entry, name, "Sample heading", "text");
      if (asString.ok) { methods.heading = name; methods.headingArg = "string"; continue; }
      const asObject = await probe(entry, name, { text: "Sample heading", heading: "Sample heading", value: "Sample heading" }, "text");
      if (asObject.ok) { methods.heading = name; methods.headingArg = "object"; continue; }
    }
    if (!methods.image) {
      const asImage = await probe(entry, name, imageBlob("1600x900"), "mediaContainer");
      if (asImage.ok) methods.image = name;
      else if (asImage.error && /image|bitmap|aspect/i.test(asImage.error)) imageProbeError = asImage.error;
    }
  }
  const results = [];
  for (const scenario of scenarios) {
    const doc = createDocument({ width: scenario.width, height: scenario.height, background: scenario.background || false });
    const live = await loadEntry(entry, doc);
    const owned = new Map();
    const bitmaps = new Map();
    const steps = [];
    let order = 0;
    for (const raw of scenario.steps) {
      const kind = raw.slice(0, 1);
      const value = raw.slice(2);
      const method = kind === "h" ? methods.heading : methods.image;
      if (!method) { steps.push({ kind, method: "", skipped: true, after: snapshot(doc, owned, bitmaps) }); continue; }
      const before = new Set(doc.page.children.toArray());
      const createdBefore = doc.log.created.length;
      const arg = kind === "h" ? (methods.headingArg === "object" ? { text: value, heading: value, value } : value) : imageBlob(value);
      let returned = "";
      let threw = "";
      try {
        const answer = await withTimeout(live[method](arg), 3000, `${method}()`);
        returned = typeof answer === "string" ? answer : answer && typeof answer === "object" && typeof answer.message === "string" ? answer.message : "";
      } catch (error) {
        threw = String(error?.message || error);
      }
      const fresh = doc.page.children.toArray().filter((node) => !before.has(node) && (node.type === "text" || node.type === "mediaContainer"));
      for (const node of fresh) {
        order += 1;
        owned.set(node, order);
        if (node.type === "mediaContainer") {
          const [w, h] = value.split("x").map(Number);
          bitmaps.set(node, { width: w, height: h });
        }
      }
      const created = doc.log.created.length > createdBefore;
      steps.push({ kind, method, value, added: fresh.length > 0, created, returned, threw, after: snapshot(doc, owned, bitmaps) });
    }
    results.push({ ...scenario, steps, violations: [...new Set(doc.log.violations)] });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, exposed, methods, imageProbeError, scenarios: results })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error?.message || error).split("\n")[0].slice(0, 400) })}\n`);
}).finally(() => setTimeout(() => process.exit(0), 10).unref());
