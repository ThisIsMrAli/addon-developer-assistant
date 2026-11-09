/**
 * Run the add-on's own document sandbox code on sample pages and measure where things land.
 * This replaces pattern-matching the placement maths: `page.width / 2 +` in dead code proves nothing,
 * and `Math.min(Math.round(w / 16), 72)` is as good as `Math.min(72, …)`.
 *
 * The code runs in a child Node process with a time limit, against document-stand-in.mjs.
 * Nothing here is Adobe Express. A pass is "the maths holds on these pages", not an Express pass.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./sandbox-sim-child.mjs", import.meta.url));

/** Sample pages and what each one adds. Kept here so a rule change shows up in one place. */
export const SCENARIOS = [
  { name: "landscape four headings", width: 1920, height: 1080, steps: ["h:One", "h:Two", "h:Three", "h:Four"], expectAll: true, aligned: true },
  { name: "portrait four headings", width: 1080, height: 1920, steps: ["h:Heading number one", "h:Two", "h:A longer third heading here", "h:Four"], expectAll: true, aligned: true },
  { name: "square heading image heading", width: 1080, height: 1080, steps: ["h:One", "h:Two", "i:1600x900", "h:Three", "i:600x1200"], expectAll: true, aligned: true },
  { name: "image first", width: 1920, height: 1080, steps: ["i:600x1200", "h:One", "h:Two", "h:Three"], expectAll: true, aligned: true },
  { name: "full-bleed background", width: 1920, height: 1080, background: true, steps: ["h:One", "h:Two", "i:1600x900", "h:Three"], expectAll: true, aligned: true },
  { name: "unlocked full-bleed background", width: 1080, height: 1080, background: "unlocked", steps: ["h:One", "h:Two", "h:Three"], expectAll: true, aligned: true },
  { name: "thirty headings", width: 1920, height: 1080, steps: Array.from({ length: 30 }, (_, i) => `h:Heading ${i + 1}`), expectFirst: 6, order: true },
  { name: "small page fills up", width: 320, height: 200, steps: Array.from({ length: 12 }, (_, i) => `h:Heading number ${i + 1}`), expectFirst: 1, order: true },
  { name: "landscape even gaps", width: 1920, height: 1080, steps: ["h:Alpha", "h:Beta title", "h:Gamma", "i:640x400"], expectAll: true, aligned: true, evenGaps: true, stable: true },
  { name: "locked logo and footer", width: 1920, height: 1080, existing: [{ x: 860, y: 60, width: 200, height: 120, locked: true, id: "logo" }, { x: 0, y: 980, width: 1920, height: 100, locked: true, id: "footer" }], steps: ["h:One", "h:Two", "h:Three"], expectAll: true },
  { name: "long heading on an empty square page", width: 1080, height: 1080, steps: ["h:A heading of about seventy-five characters that must wrap on a square page"], expectAll: true },
  { name: "tiny and thin images", width: 1080, height: 1080, steps: ["i:2x2", "i:1x1000", "i:3000x10", "i:40x30"], expectFirst: 1 }
];

/** Runs the scenarios. `entry` is the sandbox file that calls runtime.exposeApi. */
export function simulateSandbox({ dir, entry, scenarios = SCENARIOS, timeoutMs = 30000 }) {
  const result = spawnSync(process.execPath, [CHILD], {
    input: JSON.stringify({ dir, entry, scenarios }),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "" }
  });
  if (result.error?.code === "ETIMEDOUT") return { ok: false, error: `The sandbox code did not finish on the sample pages within ${Math.round(timeoutMs / 1000)} s.` };
  const line = String(result.stdout || "").trim().split("\n").filter((item) => item.startsWith("{")).at(-1);
  if (!line) return { ok: false, error: (String(result.stderr || "").trim().split("\n").slice(-4).join(" ") || "The sandbox simulation printed nothing.").slice(0, 600) };
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: "The sandbox simulation printed something that is not JSON." };
  }
}

/** The sandbox entry: a sandbox-role file that calls exposeApi, preferring the manifest's documentSandbox name. */
export function sandboxEntry(dir, files, manifest) {
  const sandboxNames = (manifest?.entryPoints || []).map((point) => String(point.documentSandbox || "")).filter(Boolean).map((name) => path.basename(name).replace(/\.[^.]+$/, ""));
  const source = files.filter((file) => /\.(mjs|cjs|jsx?|tsx?)$/i.test(file.rel) && !/(^|\/)(dist|build|node_modules)\//.test(file.rel));
  let candidates = source.filter((file) => /exposeApi/.test(file.text));
  // Without runtime.exposeApi, the exported functions of a file that edits the document are the API.
  if (!candidates.length) candidates = source.filter((file) => /\beditor\.(create|loadBitmapImage)/.test(file.text) && /\bexport\b/.test(file.text));
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] ? path.join(dir, candidates[0].rel) : "";
  function score(file) {
    const base = path.basename(file.rel).replace(/\.[^.]+$/, "");
    return (sandboxNames.includes(base) ? 2 : 0) + (/(^|\/)sandbox\//.test(file.rel) ? 1 : 0);
  }
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

function overlap(a, b) {
  return a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5;
}

/**
 * What is wrong with the measured layout, as sentences. Rules:
 * - Every add either places a node inside the page, clear of a margin, or leaves nothing and says why.
 * - Added nodes never overlap each other or existing content. A full-bleed background is not content.
 * - Text stays readable (at least 18px), and an image keeps its bitmap's aspect ratio.
 * - While the page has room, headings stack top to bottom on one shared line, centred or on the left margin.
 * - When more columns open, the reading order (columns left to right, top to bottom) is the order of adding.
 */
export function placementProblems(sim, { text = true, image = true } = {}) {
  const problems = [];
  if (!sim?.ok) {
    problems.push(`Inserted content has no checked positioning or bounds: the sandbox code could not be run on sample pages (${sim?.error || "unknown error"}). Expose the add functions with runtime.exposeApi, read the page size from editor.context.insertionParent, and place each node inside the page and clear of existing content (boundsLocal, boundsInParent, setPositionInParent). The default 100pt text sits on the top-left origin and runs off the left edge.`);
    return problems;
  }
  if (text && !sim.methods?.heading) problems.push(`No method in runtime.exposeApi (${(sim.exposed || []).join(", ") || "none"}) created text when the panel passed it a heading string.`);
  if (image && !sim.methods?.image) problems.push(`No method in runtime.exposeApi (${(sim.exposed || []).join(", ") || "none"}) created an image container when the panel passed it an image Blob.${sim.imageProbeError ? ` It threw: ${sim.imageProbeError}` : ""}`);
  const add = (message) => { if (!problems.includes(message)) problems.push(message); };
  for (const scenario of sim.scenarios || []) {
    const steps = scenario.steps.filter((step) => (step.kind === "h" && text && sim.methods?.heading) || (step.kind === "i" && image && sim.methods?.image));
    if (!steps.length) continue;
    const W = scenario.width;
    const H = scenario.height;
    const where = `on a ${W}x${H} page (${scenario.name})`;
    const margin = Math.min(W, H) * 0.02;
    for (const v of scenario.violations || []) add(`${v} (${scenario.name})`);
    let index = 0;
    for (const step of steps) {
      index += 1;
      if (step.threw) add(`${step.method}() threw "${step.threw}" ${where}.`);
      const expected = scenario.expectAll || index <= (scenario.expectFirst || 0);
      if (expected && !step.added && !step.threw) add(`${step.method}() added nothing ${where}, although the page has room${step.returned ? ` (it said "${step.returned}")` : ""}.`);
      if (!step.added && !step.threw && !step.returned) add(`${step.method}() added nothing and returned no message ${where}. Say why, for example that the page is full.`);
      const ours = step.after.filter((node) => node.ours);
      const others = step.after.filter((node) => !node.ours && !node.background);
      for (const node of ours) {
        const off = node.x < margin - 0.5 || node.y < margin - 0.5 || node.x + node.w > W - margin + 0.5 || node.y + node.h > H - margin + 0.5;
        if (off) add(`${node.kind === "text" ? `Heading "${node.text}"` : "An image"} lands at x ${round(node.x)}, y ${round(node.y)}, ${round(node.w)}x${round(node.h)} ${where}, which is outside the page or within 2% of its edge.`);
        if (node.kind === "text" && node.fontSize < 18) add(`Heading "${node.text}" shrinks to ${round(node.fontSize)}px ${where}. Keep text at a readable size, or refuse and say the page is full.`);
        if (node.kind === "image" && Math.min(node.w, node.h) < 48) add(`An image shrinks to ${round(node.w)}x${round(node.h)} ${where}.`);
        if (node.kind === "image" && node.bitmap && Math.abs(node.w / node.h - node.bitmap.width / node.bitmap.height) / (node.bitmap.width / node.bitmap.height) > 0.01) add(`An image is stretched to ${round(node.w)}x${round(node.h)} from a ${node.bitmap.width}x${node.bitmap.height} bitmap ${where}.`);
        for (const other of others) if (overlap(node, other)) add(`${node.kind === "text" ? `Heading "${node.text}"` : "An image"} covers existing content ${where}.`);
      }
      for (let a = 0; a < ours.length; a += 1) {
        for (let b = a + 1; b < ours.length; b += 1) {
          if (overlap(ours[a], ours[b])) add(`${label(ours[a])} and ${label(ours[b])} overlap ${where}.`);
        }
      }
    }
    // NP10: a heading already on the page keeps its place and size when the next item is added,
    // unless the layout really changed (another column, or a smaller font for every heading).
    if (scenario.stable) {
      for (let i = 1; i < steps.length; i += 1) {
        const before = steps[i - 1].after.filter((node) => node.ours && node.kind === "text");
        const after = steps[i].after;
        for (const node of before) {
          const now = after.find((item) => item.id === node.id);
          if (!now) continue;
          const moved = Math.abs(now.x - node.x) > 0.5 || Math.abs(now.y - node.y) > 0.5 || Math.abs(now.w - node.w) > 0.5;
          if (moved) { add(`Heading "${node.text}" moved from x ${round(node.x)}, y ${round(node.y)} to x ${round(now.x)}, y ${round(now.y)} when ${steps[i].kind === "h" ? `"${steps[i].value}"` : "an image"} was added ${where}, although the page had room. Leave placed headings where they are.`); break; }
        }
      }
    }
    const final = steps[steps.length - 1]?.after || [];
    const headings = final.filter((node) => node.ours && node.kind === "text").sort((a, b) => a.order - b.order);
    if (scenario.aligned && headings.length > 1) {
      const sameCentre = headings.every((node) => near(node.x + node.w / 2, headings[0].x + headings[0].w / 2, 2));
      const sameLeft = headings.every((node) => near(node.x, headings[0].x, 2));
      const centred = sameCentre && near(headings[0].x + headings[0].w / 2, W / 2, W * 0.02);
      const leftMargin = sameLeft && headings[0].x <= W * 0.15;
      if (!centred && !leftMargin) add(`Headings are not on one shared line ${where}: centres at ${headings.map((node) => round(node.x + node.w / 2)).join(", ")}. Stack them on one centred column (or on the left margin) while the page has room.`);
      for (let i = 1; i < headings.length; i += 1) {
        if (headings[i].y < headings[i - 1].y + headings[i - 1].h - 0.5) {
          add(`Heading "${headings[i].text}" is not below "${headings[i - 1].text}" ${where}. Each new heading goes under the previous one.`);
          break;
        }
      }
    }
    // NP12: the gap between consecutive headings is the same down the column.
    if (scenario.evenGaps && headings.length > 2) {
      const gaps = [];
      for (let i = 1; i < headings.length; i += 1) gaps.push(headings[i].y - (headings[i - 1].y + headings[i - 1].h));
      const low = Math.min(...gaps);
      const high = Math.max(...gaps);
      if (high - low > Math.max(2, low * 0.25)) add(`The gaps between headings are uneven ${where}: ${gaps.map(round).join(", ")} px. Measure each heading with boundsLocal and use one gap.`);
    }
    if (scenario.order && headings.length > 1) {
      const columns = [];
      for (const node of headings) {
        const cx = node.x + node.w / 2;
        const column = columns.find((item) => near(item.cx, cx, 2));
        if (column) column.nodes.push(node);
        else columns.push({ cx, nodes: [node] });
      }
      columns.sort((a, b) => a.cx - b.cx);
      const reading = columns.flatMap((column) => column.nodes.sort((a, b) => a.y - b.y)).map((node) => node.order);
      const added = headings.map((node) => node.order);
      if (reading.join(",") !== added.join(",")) add(`With ${headings.length} headings ${where}, the columns do not read in the order they were added (left to right, top to bottom). Fill columns from left to right.`);
    }
  }
  if (problems.some((item) => /lands at|overlap|covers existing/.test(item))) {
    add("Measure each node with boundsLocal and boundsInParent, then place it with setPositionInParent in free space inside the page, clear of the edge, of other added nodes and of existing content.");
  }
  return problems;
}

function label(node) {
  return node.kind === "text" ? `Heading "${node.text}"` : "an image";
}

function round(value) {
  return Math.round(Number(value) * 10) / 10;
}

export function sandboxSimAvailable() {
  return fs.existsSync(CHILD);
}
