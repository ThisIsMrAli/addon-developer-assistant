import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkJsSyntax, controlFlow, environmentSniffProblems, iframeImageCalls, imageKeepsContentActive, projectPanels, scanHtml, scanJs, storageKinds, stripComments, sandboxEngineProblems } from "./code-scan.mjs";
import { placementProblems, sandboxEntry, simulateSandbox } from "./sandbox-sim.mjs";
import { sandboxApiMismatches } from "./standin.mjs";
import { buildProject } from "./package-addon.mjs";

/** Pinned to the release whose scaffolder was checked. `AddOnBuilder._updateManifest` sets `testId` and the display name. */
export const CREATE_CCWEB_ADD_ON = "@adobe/create-ccweb-add-on@3.11.0";

/** `@adobe/ccweb-add-on-manifest` rejects any other `name` during `ccweb-add-on-scripts build`. */
export const MANIFEST_NAME = /^[a-zA-Z0-9]+[a-zA-Z0-9 ]{2,44}$/;

const PLACEHOLDER_NAMES = new Set([
  "", "name", "addon", "add-on", "your add-on", "your addon", "todo", "placeholder",
  "template", "add-on name", "your add-on name"
]);

const ANSWERED = new Set(["origin", "feasibility", "design", "implement"]);

/**
 * Refuse every write until origin, feasibility, design, and implement=write are answered.
 * A new folder also needs a template id that was fetched this session.
 */
export function gate(session) {
  const asks = session.asks || [];
  const answer = (id) => asks.find((item) => item.id === id && item.status === "answered");
  const missing = [...ANSWERED].filter((id) => !answer(id));
  if (missing.length) {
    return { ok: false, error: `Refusing to write. Still unanswered: ${missing.join(", ")}.` };
  }
  if (answer("implement").answer !== "write") {
    return { ok: false, error: "Refusing to write. The implement answer was not write." };
  }
  const feature = answer("feasibility").answer;
  if (!["iframe", "sandbox", "unsupported"].includes(feature)) {
    return { ok: false, error: "Refusing to write. Feasibility has no class." };
  }
  if (answer("origin").answer === "new") {
    const template = answer("template");
    const allowed = session.templates?.ids || [];
    if (!template) return { ok: false, error: "Refusing to write. No template was chosen." };
    if (!allowed.includes(template.answer)) {
      return { ok: false, error: `Refusing to write. ${template.answer} was not in the fetched template list.` };
    }
  }
  return { ok: true, feature, design: answer("design").answer, origin: answer("origin").answer, template: answer("template")?.answer || "" };
}

export function scaffoldProject({ dir, template }) {
  if (process.env.EXPRESS_DEVELOP_SCAFFOLD === "fixture") {
    writeFixture(dir, template);
    return { dir, template, via: "fixture" };
  }
  const parent = path.dirname(dir);
  const name = path.basename(dir);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir).filter((entry) => entry !== ".gitkeep");
    if (entries.length) throw new Error(`${dir} is not an empty folder.`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const result = spawnSync("npx", ["--yes", CREATE_CCWEB_ADD_ON, name, "--template", template, "--analytics", "off"], {
    cwd: parent,
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 10 * 1024 * 1024,
    // Closed stdin: the CLI asks about an SSL certificate after the files exist, and a waiting prompt would hang.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", npm_config_yes: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false" }
  });
  const manifest = fs.existsSync(path.join(dir, "src", "manifest.json")) || fs.existsSync(path.join(dir, "manifest.json"));
  if (!manifest) {
    const detail = `${result.stderr || ""}\n${result.stdout || ""}`.trim().split("\n").slice(-30).join("\n");
    throw new Error(detail || `create-ccweb-add-on exited ${result.status} without a manifest. The folder name must be a valid npm package name.`);
  }
  return { dir, template, cliStatus: result.status };
}

/**
 * What the brief needs the agent to call. This does not write the add-on.
 * Text and images in the document use the document sandbox. A Spectrum form is panel UI.
 * Network and OAuth need manifest permissions.
 */
export function briefNeeds(brief) {
  const text = String(brief || "");
  const needs = [];
  const onDocument = /\bdocument sandbox\b/i.test(text) || /\binto the document\b/i.test(text) || (/\b(document|canvas|artboard)\b/i.test(text) && /\b(text|heading|image|photo)\b/i.test(text));
  if (/\b(styled\s+text|create\s*text|add\s+(?:styled\s+)?text|heading|headline)\b/i.test(text) || (onDocument && /\btext\b/i.test(text))) needs.push("text");
  if (/\b(image|photo|picture)\b/i.test(text)) needs.push("image");
  if (/\b(spectrum|sp-textfield|sp-button)\b/i.test(text) || (/\bform\b/i.test(text) && /\bpanel\b/i.test(text))) needs.push("panel");
  if (/\boauth\b/i.test(text) || /\b(dropbox|network request)\b/i.test(text)) needs.push("oauth");
  if (/\bclientstorage\b/i.test(text) || (/\boauth\b/i.test(text) && /\bstore\b/i.test(text))) needs.push("storage");
  if (/\b(rendition|createrenditions|download)\b/i.test(text) || (/\bexport\b/i.test(text) && /\b(png|page|document|rendition)\b/i.test(text))) needs.push("rendition");
  return [...new Set(needs)];
}

/**
 * The handoff snippet for headings and images in the document sandbox.
 * - Nodes are matched by id and found again in page.children on every call: Express hands out a new
 *   object for a node each time, and a reference must not be held across calls (NP12).
 * - A new heading goes after the last one, in the same column, and nothing else moves (NP10). Only
 *   when it does not fit is everything laid out again: one to three columns that read left to right,
 *   the font from the page cap down to 24 px before another column opens, then down to 18 px.
 *   A heading wider than its column wraps with TextLayout.autoHeight before it shrinks (NP3).
 *   Every heading gap is the same, measured from the real text bounds (boundsLocal) (NP12).
 * - Only a full-page or near full-page node is background. A locked logo or footer is content (NP2).
 * - Images go below the headings, at least 48 px on the short side, or are refused with a message (NP5).
 * - createImageContainer runs in the afterAsyncCallback of keepContentActiveDuringAsync. Its initialSize
 *   keeps the bitmap's aspect ratio (Express rejects one more than 1% off).
 * - No built-in the Express sandbox may lack (no .at, findLast, Object.hasOwn, replaceAll) (NP11).
 */
export const TEXT_INSIDE_PAGE = `import addOnSandboxSdk from "add-on-sdk-document-sandbox";
import { editor, constants } from "express-document-sdk";

const { runtime } = addOnSandboxSdk.instance;

const FULL_MESSAGE = "The page is full. This stays at a readable size, so it was not added.";
const SMALL_IMAGE_MESSAGE = "This image is too thin to show at 48 px or more on each side inside the page, so it was not added.";
const READABLE_FONT = 24;
const MIN_FONT = 18;
const MIN_IMAGE_SIDE = 48;
const MAX_COLUMNS = 3;
const IMAGE_GAP = 12;
const TEXT_COLOR = { red: 0.1, green: 0.1, blue: 0.1, alpha: 1 };

// Express returns a new object for a node each time the API hands one out, and a node reference
// must not be held across calls. So the layout keeps only node ids (Node.id, stable for the node)
// and finds the nodes again in page.children on every call. Never compare nodes with === or a Set.
const pages = {};

function pageState(page) {
  if (!pages[page.id]) pages[page.id] = { columns: 1, size: 0, headings: [], images: [] };
  return pages[page.id];
}

function nodesById(page) {
  const found = {};
  for (const item of page.children) found[item.id] = item;
  return found;
}

function marginOf(page) {
  return Math.round(Math.min(page.width, page.height) * 0.08);
}

function capOf(page) {
  return Math.min(72, Math.round(page.width / 16));
}

/** One gap for every heading on the page, so the spacing stays even whatever each heading wraps to. */
function headingGap(page) {
  return Math.max(8, Math.round(capOf(page) * 0.3));
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5;
}

/** Only a full-page (or near full-page) node is background. A locked logo or footer is content. */
function isBackground(box, page) {
  return box.width >= page.width * 0.95 && box.height >= page.height * 0.95;
}

function obstacles(page, skip) {
  const blocked = [];
  for (const item of page.children) {
    if (skip.indexOf(item.id) >= 0) continue;
    const box = item.boundsInParent;
    if (!box || isBackground(box, page)) continue;
    blocked.push(box);
  }
  return blocked;
}

function column(page, columns, index) {
  const margin = marginOf(page);
  const usable = page.width - margin * 2;
  const gutter = columns > 1 ? Math.round(usable * 0.04) : 0;
  const width = (usable - gutter * (columns - 1)) / columns;
  return { centre: margin + width / 2 + index * (width + gutter), width };
}

/** Font size, then wrap (TextLayout.autoHeight) only when the line is wider than the column. Returns the measured size. */
function shapeHeading(node, size, maxWidth) {
  node.fullContent.applyCharacterStyles({ fontSize: size, color: TEXT_COLOR }, { start: 0, length: node.fullContent.text.length });
  if (node.layout.type !== constants.TextLayout.autoWidth) node.layout = { type: constants.TextLayout.autoWidth };
  let box = node.boundsLocal;
  let wrap = 0;
  if (box.width > maxWidth + 0.5) {
    wrap = Math.floor(maxWidth);
    node.layout = { type: constants.TextLayout.autoHeight, width: wrap };
    box = node.boundsLocal;
  }
  return { width: box.width, height: box.height, size, wrap };
}

function restoreHeading(node, entry) {
  node.fullContent.applyCharacterStyles({ fontSize: entry.size, color: TEXT_COLOR }, { start: 0, length: node.fullContent.text.length });
  node.layout = entry.wrap ? { type: constants.TextLayout.autoHeight, width: entry.wrap } : { type: constants.TextLayout.autoWidth };
}

/** First free row in a column, from y down, clear of every blocked box. */
function freeRow(page, centre, size, y, blocked, gap) {
  const bottom = page.height - marginOf(page);
  let top = y;
  for (let guard = 0; guard < 400; guard += 1) {
    const rect = { x: centre - size.width / 2, y: top, width: size.width, height: size.height };
    if (rect.y + rect.height > bottom + 0.5) return null;
    let hit = null;
    for (const box of blocked) if (rectsOverlap(rect, box)) { hit = box; break; }
    if (!hit) return rect;
    top = hit.y + hit.height + gap;
  }
  return null;
}

function fontSteps(cap) {
  const steps = [];
  for (let size = cap; size > READABLE_FONT; size = Math.floor(size * 0.85)) steps.push(size);
  steps.push(READABLE_FONT);
  return steps;
}

/** Images fill the space below top, centred, each at least 48 px on its short side. */
function planImages(page, list, top, blocked, alone) {
  const margin = marginOf(page);
  const bottom = page.height - margin;
  const usable = page.width - margin * 2;
  const slots = [];
  if (!list.length) return slots;
  const share = (bottom - top - IMAGE_GAP * (list.length - 1)) / list.length;
  const tallest = alone ? Math.min(share, (page.height - margin * 2) * 0.5) : share;
  let y = top;
  for (const entry of list) {
    if (tallest <= 0) return null;
    const scale = Math.min(1, usable / entry.width, tallest / entry.height);
    const size = { width: entry.width * scale, height: entry.height * scale };
    if (Math.min(size.width, size.height) < MIN_IMAGE_SIDE - 0.5) return null;
    const rect = freeRow(page, page.width / 2, size, y, blocked, IMAGE_GAP);
    if (!rect) return null;
    slots.push({ id: entry.id, kind: "image", rect });
    y = rect.y + rect.height + IMAGE_GAP;
  }
  return slots;
}

function lowest(rects, fallback) {
  let bottom = fallback;
  for (const rect of rects) bottom = Math.max(bottom, rect.y + rect.height + IMAGE_GAP);
  return bottom;
}

function place(node, rect) {
  const box = node.boundsLocal;
  if (Math.abs(box.width - rect.width) > 0.5 || Math.abs(box.height - rect.height) > 0.5) {
    node.resize({ width: rect.width, height: rect.height, behavior: constants.ResizeBehavior.contain, avoidScalingVisualDetailsIfPossible: false });
  }
  node.setPositionInParent({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, node.centerPointLocal);
}

/**
 * Everything laid out again: headings in 1 to 3 columns that read left to right, the font from the
 * page cap down to 24 px before another column opens, and as a last step down to 18 px. Images go below.
 * Only used when the new item does not fit next to what is already on the page.
 */
function reflow(page, state, byId, extraImage) {
  const margin = marginOf(page);
  const gap = headingGap(page);
  const ours = state.headings.map((entry) => entry.id).concat(state.images.map((entry) => entry.id));
  if (extraImage) ours.push(extraImage.id);
  const blocked = obstacles(page, ours);
  const images = extraImage ? state.images.concat([extraImage]) : state.images;
  const tries = [];
  for (let columns = Math.max(1, state.columns); columns <= MAX_COLUMNS; columns += 1) {
    for (const size of fontSteps(capOf(page))) tries.push({ columns, size });
  }
  for (let size = READABLE_FONT - 2; size >= MIN_FONT; size -= 2) tries.push({ columns: MAX_COLUMNS, size });
  for (const attempt of tries) {
    const slots = [];
    let index = 0;
    let y = margin;
    let ok = true;
    for (const entry of state.headings) {
      const node = byId[entry.id];
      let rect = null;
      while (!rect && index < attempt.columns) {
        const col = column(page, attempt.columns, index);
        const shape = shapeHeading(node, attempt.size, col.width);
        rect = freeRow(page, col.centre, shape, y, blocked, gap);
        if (rect) slots.push({ id: entry.id, kind: "text", rect, column: index, shape });
        else { index += 1; y = margin; }
      }
      if (!rect) { ok = false; break; }
      y = rect.y + rect.height + gap;
    }
    if (!ok) continue;
    const top = lowest(slots.map((slot) => slot.rect), margin);
    const imageSlots = planImages(page, images, top, blocked.concat(slots.map((slot) => slot.rect)), !slots.length);
    if (!imageSlots) continue;
    return { columns: attempt.columns, size: attempt.size, slots: slots.concat(imageSlots) };
  }
  for (const entry of state.headings) restoreHeading(byId[entry.id], entry);
  return null;
}

function applyPlan(page, state, byId, plan) {
  state.columns = plan.columns;
  state.size = plan.size;
  for (const slot of plan.slots) {
    const node = byId[slot.id];
    if (!node) continue;
    place(node, slot.rect);
    const list = slot.kind === "text" ? state.headings : state.images;
    for (const entry of list) {
      if (entry.id !== slot.id) continue;
      entry.rect = slot.rect;
      if (slot.shape) { entry.size = slot.shape.size; entry.wrap = slot.shape.wrap; entry.column = slot.column; }
    }
  }
}

/** Drop entries whose node the user deleted. */
function prune(state, byId) {
  state.headings = state.headings.filter((entry) => byId[entry.id]);
  state.images = state.images.filter((entry) => byId[entry.id]);
}

export function addHeading(heading) {
  const text = String(heading ?? "").trim();
  if (!text) return "Type a heading first.";
  const page = editor.context.insertionParent;
  const state = pageState(page);
  const node = editor.createText(text);
  page.children.append(node);
  const id = node.id;
  let byId = nodesById(page);
  prune(state, byId);
  const gap = headingGap(page);
  const size = state.size || capOf(page);
  const last = state.headings.length ? state.headings[state.headings.length - 1] : null;
  // First try: leave every heading where it is and put the new one after the last, in the same column.
  const imageIds = state.images.map((entry) => entry.id);
  const blocked = obstacles(page, [id].concat(imageIds));
  let placed = null;
  for (let index = last ? last.column : 0; index < state.columns && !placed; index += 1) {
    const col = column(page, state.columns, index);
    const shape = shapeHeading(node, size, col.width);
    const start = last && index === last.column ? last.rect.y + last.rect.height + gap : marginOf(page);
    const rect = freeRow(page, col.centre, shape, start, blocked, gap);
    if (rect) placed = { rect, shape, column: index };
  }
  if (placed) {
    const entry = { id, rect: placed.rect, size: placed.shape.size, wrap: placed.shape.wrap, column: placed.column };
    state.headings.push(entry);
    place(node, placed.rect);
    // Images move only when the new heading needs their room.
    const images = state.images.filter((item) => byId[item.id]);
    const covered = images.some((item) => rectsOverlap(byId[item.id].boundsInParent, placed.rect) || byId[item.id].boundsInParent.y < placed.rect.y + placed.rect.height);
    if (!covered) { state.size = size; return ""; }
    const ours = state.headings.map((item) => item.id).concat(imageIds);
    const top = lowest(state.headings.map((item) => item.rect), marginOf(page));
    const imageSlots = planImages(page, images, top, obstacles(page, ours).concat(state.headings.map((item) => item.rect)), false);
    if (imageSlots) {
      for (const slot of imageSlots) place(byId[slot.id], slot.rect);
      state.size = size;
      return "";
    }
    state.headings.pop();
  }
  // Second try: lay everything out again (more columns, then a smaller font).
  state.headings.push({ id, rect: null, size, wrap: 0, column: 0 });
  byId = nodesById(page);
  const plan = reflow(page, state, byId, null);
  if (!plan) {
    state.headings.pop();
    node.removeFromParent();
    return FULL_MESSAGE;
  }
  applyPlan(page, state, byId, plan);
  return "";
}

/** initialSize keeps the bitmap's aspect ratio: at most 512 px long, and at least 48 px short when that fits. */
function initialSizeOf(bitmap) {
  const longSide = Math.max(bitmap.width, bitmap.height);
  const shortSide = Math.min(bitmap.width, bitmap.height);
  const scale = Math.max(Math.min(1, 512 / longSide), MIN_IMAGE_SIDE / shortSide);
  return { width: bitmap.width * scale, height: bitmap.height * scale };
}

export async function addImage(blob) {
  const page = editor.context.insertionParent;
  const bitmap = await editor.loadBitmapImage(blob);
  const initialSize = initialSizeOf(bitmap);
  const margin = marginOf(page);
  const usable = { width: page.width - margin * 2, height: page.height - margin * 2 };
  const fitScale = Math.min(1, usable.width / initialSize.width, usable.height / initialSize.height);
  if (Math.min(initialSize.width, initialSize.height) * fitScale < MIN_IMAGE_SIDE - 0.5) return SMALL_IMAGE_MESSAGE;
  let message = FULL_MESSAGE;
  await editor.keepContentActiveDuringAsync(
    page,
    async () => {},
    () => {
      const state = pageState(page);
      const image = editor.createImageContainer(bitmap, { initialSize });
      page.children.append(image);
      const entry = { id: image.id, width: initialSize.width, height: initialSize.height, rect: null };
      let byId = nodesById(page);
      prune(state, byId);
      // First try: below everything this add-on placed, without moving anything.
      const ours = state.headings.map((item) => item.id).concat(state.images.map((item) => item.id));
      const placedRects = ours.map((id) => byId[id].boundsInParent);
      const top = lowest(placedRects, margin);
      const slots = planImages(page, [entry], top, obstacles(page, [entry.id]), !ours.length);
      if (slots) {
        entry.rect = slots[0].rect;
        state.images.push(entry);
        place(image, slots[0].rect);
        message = "";
        return;
      }
      byId = nodesById(page);
      const plan = reflow(page, state, byId, entry);
      if (!plan) {
        image.removeFromParent();
        message = FULL_MESSAGE;
        return;
      }
      state.images.push(entry);
      applyPlan(page, state, byId, plan);
      message = "";
    }
  );
  return message;
}

if (typeof runtime !== "undefined") runtime.exposeApi({ addHeading, addImage });
`;

/** The pages and calls the agent must use. Nothing here is written into the project. */
export function implementationHandoff({ brief, pages = [], design = "" }) {
  const needs = briefNeeds(brief);
  const apis = [];
  if (needs.includes("text")) {
    apis.push({
      api: "editor.createText()",
      runtime: "document sandbox",
      note: "Create the text in code.js. Read the page size from editor.context.insertionParent (use-text.md). Cap the font (Math.min(72, page width / 16)) and call resize() with constants.ResizeBehavior.contain for both width and height, and only when boundsLocal is larger than the page minus an 8% margin (resize-elements.md). Stack headings on one centre line with setPositionInParent, using centerPointLocal from boundsLocal (position-elements.md). The next heading goes below the previous one and below existing content (boundsInParent). A locked or full-page background node is not content: place on top of it. Open more columns only when the first cannot take another heading at a readable size (about 24px), and fill them left to right so they read in the order added. Do not shrink a heading to a few pixels, and do not drop it onto an earlier row. When nothing readable fits, do not add the node, and say the page is full. Do not leave the default 100pt text on the top-left origin, do not scale a short heading to the full page width, and do not stack every heading on the same point. An empty field shows \"Type a heading first.\" and adds nothing.",
      snippet: TEXT_INSIDE_PAGE
    });
  }
  if (needs.includes("image")) {
    apis.push({
      api: "editor.loadBitmapImage() and editor.createImageContainer()",
      runtime: "document sandbox",
      note: "Build the image in the document sandbox. Adobe's Editor reference (keepContentActiveDuringAsync, Example 2, load an image from a Blob) awaits editor.loadBitmapImage(blob), then calls editor.keepContentActiveDuringAsync(insertionParent, async () => {}, afterAsyncCallback). createImageContainer runs in that afterAsyncCallback, not in the open after the await and not inside the async lambda. editor.queueAsyncEdit() was removed from the SDK (Adobe changelog 2026-08-03) and is not accepted. The document sandbox runs on QuickJS without the ES2022+ built-ins, and it may also lack String.prototype.replaceAll: no Array.prototype.at, findLast, toSorted, toReversed, with, Object.hasOwn, Object.groupBy, replaceAll, structuredClone or timers. record removes them before it runs the code, and flags each use. Give createImageContainer an initialSize with the bitmap's own aspect ratio (bitmap.width and bitmap.height scaled by one factor). Express throws \"Aspect ratio of initialSize must match aspect ratio of bitmapData to within 1%\" otherwise, and the stand-in used by record and the audit throws the same. Fit the image with resize() and place it below the heading column, using boundsInParent, so it does not cover a heading (position-elements.md, resize-elements.md). A later heading continues the same centre line and the image moves down to make room. A centered addImage() covers the heading under it. A panel call such as this._sandboxProxy.addImage(blob) is a sandbox call, not addOnUISdk.app.document.addImage.",
    });
  }
  if (needs.includes("panel") || (design === "swc" && !needs.includes("oauth"))) {
    apis.push({
      api: "sp-theme, sp-textfield, sp-button",
      runtime: "iframe panel",
      note: "Build the form with Spectrum Web Components. Do not leave a plain input labelled Note."
    });
  }
  if (needs.includes("oauth") || needs.includes("storage")) {
    apis.push({
      api: "addOnUISdk.app.oauth.authorize()",
      runtime: "iframe runtime",
      note: "Call authorize and catch a rejection. The host list goes in entryPoints[].permissions.oauth. Store tokens with addOnUISdk.instance.clientStorage, not localStorage."
    });
  }
  if (needs.includes("rendition")) {
    apis.push({
      api: "addOnUISdk.app.document.createRenditions()",
      runtime: "iframe runtime",
      note: "Use constants.Range and RenditionIntent. A download needs entryPoints[].permissions.sandbox to include allow-downloads. exportPage is not this API."
    });
  }
  if (!apis.length) {
    apis.push({
      api: "addOnUISdk",
      runtime: "iframe panel",
      note: "Implement the brief in the panel. Do not add a placeholder field."
    });
  }
  return {
    awaitingAgent: true,
    written: false,
    brief: String(brief || ""),
    needs,
    design,
    pages,
    apis,
    note: "The agent writes this feature. A stub is not an implementation."
  };
}

/**
 * The feature is real only when parsed code calls the APIs the brief needs, the project builds,
 * and a canned stub is absent. Comments do not count. A failure is a list of problems.
 */
export function verifyFeature({ dir, brief, build = true }) {
  const needs = briefNeeds(brief);
  const { manifest } = readManifest(dir);
  const files = sourceFiles(dir);
  const problems = [];
  problems.push(...manifestIdentityProblems(manifest));
  if (!files.length) problems.push("No source was written.");
  const calls = [];
  const codeFiles = [];
  for (const file of files) {
    const rel = path.relative(dir, file.file).split(path.sep).join("/");
    if (/\.(html?)$/i.test(file.file)) continue;
    if (/\.(json)$/i.test(file.file)) continue;
    const scanned = scanJs(file.text);
    const syntax = /\.(mjs|cjs|jsx?|tsx?)$/i.test(file.file) ? checkJsSyntax(file.file) : scanned.syntax;
    if (syntax) problems.push(`${rel} does not parse. ${syntax}`);
    const role = fileRole(rel, manifest);
    codeFiles.push({ rel, file: rel, text: file.text });
    for (const call of scanned.calls) calls.push({ call, rel, role, text: file.text });
  }
  const html = files.filter((file) => /\.html?$/i.test(file.file)).map((file) => ({ ...scanHtml(file.text), rel: path.relative(dir, file.file) }));
  const panels = projectPanels([...files.map((file) => ({ ...file, rel: path.relative(dir, file.file).split(path.sep).join("/") })), ...bundleSources(dir)]);
  const code = files.map((file) => stripComments(file.text)).join("\n");
  if (isStub(code, html)) problems.push("The add-on still has a canned stub (featureReady, a develop-feature field, or only the template's Create Rectangle).");
  const sandboxCalls = calls.filter((item) => item.role === "sandbox");
  const named = (list, pattern) => list.filter((item) => pattern.test(item.call));
  if (needs.includes("text")) {
    const created = named(sandboxCalls, /(^|\.)createText$/);
    const inIframe = named(calls.filter((item) => item.role !== "sandbox"), /(^|\.)createText$/);
    if (!created.length) {
      problems.push(inIframe.length
        ? "createText() is in the iframe. Document text has to be created in the document sandbox file."
        : "Styled text needs editor.createText() in the document sandbox.");
    }
    const sandboxText = sandboxCalls.map((item) => stripComments(item.text)).join("\n");
    if (created.length && !/fontSize|applyCharacterStyles|characterStyles|\bfont\b|\bfill\b|\bcolor\b/i.test(sandboxText)) {
      problems.push("Styled text needs a style: font, size, or color.");
    }
  }
  const sandboxFiles = codeFiles.filter((file) => fileRole(file.rel, manifest) === "sandbox");
  problems.push(...sandboxEngineProblems(sandboxFiles));
  problems.push(...environmentSniffProblems(sandboxFiles));
  if (named(sandboxCalls, /(^|\.)queueAsyncEdit$/).length) problems.push("editor.queueAsyncEdit() was removed from the Express document SDK (Adobe changelog 2026-08-03: \"Deprecated APIs (queueAsyncEdit, …) are removed from the SDK\"). In Express it is undefined, so the call throws \"not a function\". Use editor.keepContentActiveDuringAsync(node, async () => {}, afterAsyncCallback) (classes/editor.md).");
  const sandboxMakesText = named(sandboxCalls, /(^|\.)createText$/).length > 0;
  const sandboxImage = named(sandboxCalls, /(^|\.)(createImageContainer|loadBitmapImage)$/).length > 0;
  const iframeImages = iframeImageCalls(codeFiles.filter((file) => fileRole(file.rel, manifest) !== "sandbox"));
  let sim = null;
  if ((needs.includes("text") && sandboxMakesText) || (needs.includes("image") && sandboxImage)) {
    const entry = sandboxEntry(dir, codeFiles, manifest);
    sim = entry ? simulateSandbox({ dir, entry }) : { ok: false, error: "no sandbox file calls runtime.exposeApi" };
    problems.push(...placementProblems(sim, { text: needs.includes("text") && sandboxMakesText, image: needs.includes("image") && sandboxImage }));
  }
  if (needs.includes("image")) {
    const created = named(calls, /(^|\.)(createImageContainer|loadBitmapImage)$/).length + iframeImages.length;
    if (!created) problems.push("An image needs editor.loadBitmapImage() and editor.createImageContainer() in the document sandbox, or addOnUISdk.app.document.addImage() in the panel.");
    else {
      if (!imageKeepsContentActive(codeFiles)) problems.push("createImageContainer() has to run in the afterAsyncCallback of editor.keepContentActiveDuringAsync(), as the Editor reference shows for loadBitmapImage (Example 2, load an image from a Blob). The async lambda must not edit the document. editor.queueAsyncEdit() was removed from the SDK (Adobe changelog 2026-08-03). Do not call createImageContainer() in the open after await loadBitmapImage().");
      if (iframeImages.length && needs.includes("text")) problems.push(`${iframeImages[0].call}() is the iframe document API. Express centres that image on the page, so it covers the headings. Build the image in the document sandbox (loadBitmapImage, createImageContainer) and place it below the headings with boundsInParent.`);
    }
  }
  if (needs.includes("panel")) {
    if (!panels.spectrum) {
      problems.push("A Spectrum form needs a Spectrum Web Component such as sp-textfield or sp-button in the markup, not in a comment.");
    }
  }
  const permissions = manifestPermissions(manifest);
  if (needs.includes("oauth")) {
    if (!named(calls, /(^|\.)authorize$/).length) {
      const opened = named(calls, /(^|\.)open$/).some((item) => item.call.startsWith("window."));
      problems.push(opened
        ? "OAuth needs addOnUISdk.app.oauth.authorize(). window.open is not that API."
        : "OAuth needs an addOnUISdk.app.oauth.authorize() call.");
    }
    if (!permissions.oauth.length) {
      problems.push(permissions.undocumentedTopLevel
        ? "OAuth needs entryPoints[].permissions.oauth. A top-level permissions key is not in the manifest version 2 schema."
        : "OAuth needs entryPoints[].permissions.oauth with the provider host.");
    }
    const flowForAuth = controlFlow(codeFiles);
    if (named(calls, /(^|\.)authorize$/).length && flowForAuth.unhandledAuthorize) {
      problems.push("authorize() needs a catch. An unhandled rejection is not a finished sign-in.");
    }
  }
  if (needs.includes("storage")) {
    const traced = storageKinds(codeFiles);
    if (!traced.client) problems.push(traced.local ? "Token storage needs addOnUISdk.instance.clientStorage. localStorage is not that API." : "Token storage needs addOnUISdk.instance.clientStorage.");
  }
  if (needs.includes("rendition")) {
    if (!named(calls, /(^|\.)createRenditions$/).length) {
      const fake = named(calls, /(^|\.)exportPage$/);
      problems.push(fake.length
        ? "A page rendition needs addOnUISdk.app.document.createRenditions(). exportPage() is not a document API."
        : "A page rendition needs an addOnUISdk.app.document.createRenditions() call.");
    }
    if (!permissions.sandbox.includes("allow-downloads")) problems.push("A download needs entryPoints[].permissions.sandbox to include allow-downloads.");
  }
  if (controlFlow(codeFiles).unhandledThrow) problems.push("The code throws and nothing catches it.");
  problems.push(...templateBoilerplate(dir));
  const visible = Boolean(panels.text || panels.controls);
  if ((html.length || panels.tags.length) && !visible && (needs.includes("panel") || needs.length)) problems.push("The panel is blank: no text and no control.");
  if (!needs.length) {
    const word = distinctiveWord(brief);
    if (word && !new RegExp(`\\b${word}\\b`, "i").test(code)) problems.push(`The code does not mention ${word} from the brief.`);
  }
  for (const name of sandboxApiMismatches(codeFiles, { exposed: sim?.ok ? sim.exposed : null })) {
    problems.push(`The panel calls ${name}, but the document sandbox does not expose ${name} through runtime.exposeApi.`);
  }
  let built = { ok: true, skipped: true };
  if (build && !problems.length) {
    built = buildProject(dir);
    if (!built.ok) problems.push(built.error || "The add-on did not build.");
  }
  return { ok: problems.length === 0, problems, needs, build: built, permissions, ...(sim ? { simulation: { ok: Boolean(sim.ok), exposed: sim.exposed || [], methods: sim.methods || {}, error: sim.error || "" } } : {}) };
}

function bundleSources(dir) {
  const found = [];
  for (const name of ["dist", "build"]) {
    const root = path.join(dir, name);
    if (!fs.existsSync(root)) continue;
    const walk = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(html?|jsx?|mjs)$/i.test(entry.name) && fs.statSync(full).size < 2_000_000) {
          found.push({ rel: path.relative(dir, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") });
        }
      }
    };
    walk(root);
  }
  return found;
}

/**
 * The same substitution as `@adobe/ccweb-add-on-scaffolder` `AddOnBuilder._getAddOnName`.
 * A name that already matches the manifest pattern is kept. `Color Note e` must stay `Color Note e`.
 * Running the substitution on it inserts spaces before capitals and the build then rejects the name.
 */
export function manifestDisplayName(addOnName) {
  const raw = String(addOnName || "").replace(/\s+/g, " ").trim();
  if (MANIFEST_NAME.test(raw) && !isPlaceholderName(raw)) return raw;
  const camelCase = raw.replace(/[-_]\w/g, (text) => text.replace(/[-_]/, "").toUpperCase());
  const wordCase = camelCase.replace(/([A-Z])/g, " $1").replace(/\s+/g, " ").trim();
  const titled = wordCase ? wordCase.charAt(0).toUpperCase() + wordCase.slice(1) : "";
  return MANIFEST_NAME.test(titled) && !isPlaceholderName(titled) ? titled : "";
}

export function isPlaceholderName(name) {
  return PLACEHOLDER_NAMES.has(String(name || "").replace(/\s+/g, " ").trim().toLowerCase());
}

function manifestIdentityProblems(manifest) {
  const problems = [];
  const display = String(manifest?.name || "").replace(/\s+/g, " ").trim();
  if (isPlaceholderName(display)) {
    problems.push(`The manifest name is still a placeholder ("${display}"). The scaffolder writes a display name such as Heading Panel.`);
  } else if (!MANIFEST_NAME.test(display)) {
    problems.push(`The manifest name "${display}" does not match ${MANIFEST_NAME}. A hyphenated package name is not a display name. @adobe/ccweb-add-on-scaffolder turns heading-panel into Heading Panel.`);
  }
  if (!String(manifest?.testId || "").trim()) {
    problems.push("The manifest needs a testId. ccweb-add-on-scripts rejects a developer manifest without one.");
  }
  return problems;
}

export function scrubTemplateChrome(dir, name) {
  const display = manifestDisplayName(name) || "Add on";
  let files = 0;
  const walk = (folder) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.html?$/i.test(entry.name)) {
        const before = fs.readFileSync(full, "utf8");
        let html = before.replace(/<title>\s*Get Started\s*<\/title>/gi, `<title>${display}</title>`);
        html = html.replace(/content=(["'])([\s\S]*?)\1/gi, (match, quote, value) => {
          if (!/Adobe,\s*Express,\s*Add-On|Get started with Add-on development/i.test(value)) return match;
          return `content=${quote}${display}${quote}`;
        });
        if (html !== before) {
          fs.writeFileSync(full, html);
          files += 1;
        }
      }
    }
  };
  walk(dir);
  return files;
}

function templateBoilerplate(dir) {
  const problems = [];
  const walk = (folder) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.html?$/i.test(entry.name)) {
        const html = fs.readFileSync(full, "utf8");
        if (/<title>\s*Get Started\s*<\/title>/i.test(html)) problems.push("The page title is still the template's Get Started. Use the add-on name.");
        if (/Adobe,\s*Express,\s*Add-On/i.test(html)) problems.push("The template meta keywords still list Adobe, Express, and Add-On. Replace that meta with the add-on's own words. It is not a finding about the add-on's name.");
      }
    }
  };
  walk(dir);
  return [...new Set(problems)];
}

export function applyManifestName(dir, name) {
  const display = manifestDisplayName(name);
  if (!display) return "";
  for (const rel of ["src/manifest.json", "manifest.json"]) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.name = display;
    if (!String(manifest.testId || "").trim()) manifest.testId = randomUUID();
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return file;
  }
  return "";
}

function writeFixture(dir, template) {
  const src = path.join(dir, "src");
  fs.mkdirSync(src, { recursive: true });
  const display = manifestDisplayName(path.basename(dir)) || "Local Fixture";
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: path.basename(dir), private: true, description: "Local fixture.", scripts: {} }, null, 2)}\n`);
  fs.writeFileSync(path.join(src, "manifest.json"), `${JSON.stringify({
    name: display,
    testId: randomUUID(),
    version: "1.0.0",
    manifestVersion: 2,
    requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
    entryPoints: [{ type: "panel", id: "panel1", main: "index.html" }]
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(src, "index.html"), `<!doctype html><html><body><h1>${template}</h1></body></html>\n`);
}

function sourceFiles(dir) {
  const found = [];
  const walk = (folder) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html?|jsx?|tsx?|mjs|cjs|vue|svelte|json)$/i.test(entry.name)) {
        try {
          found.push({ file: full, text: fs.readFileSync(full, "utf8") });
        } catch {
          // Unreadable source is treated as missing.
        }
      }
    }
  };
  walk(dir);
  return found;
}

function isStub(code, html) {
  if (/function\s+featureReady\s*\(/.test(code)) return true;
  const markup = html.map((page) => page.tags.join(" ") + page.text).join("\n");
  if (/develop-feature/.test(code) && /id=["']develop-feature["']/.test(code)) return true;
  if (html.some((page) => /develop-feature/.test(page.text))) return true;
  if (/Create Rectangle/.test(markup) && !html.some((page) => page.tags.includes("sp-textfield") || page.tags.includes("label") || /caption/i.test(page.text))) return true;
  return false;
}

function readManifest(dir) {
  for (const rel of ["src/manifest.json", "manifest.json"]) {
    try {
      return { rel, manifest: JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")) };
    } catch {
      // The other path may hold it.
    }
  }
  return { rel: "", manifest: {} };
}

function fileRole(rel, manifest) {
  const names = [];
  for (const point of manifest.entryPoints || []) if (point.documentSandbox) names.push(String(point.documentSandbox));
  if (names.some((name) => rel === name || rel.endsWith(`/${name}`))) return "sandbox";
  if (/\/sandbox\//.test(`/${rel}`) || /(^|\/)code\.(js|ts|mjs)$/.test(rel)) return "sandbox";
  return "iframe";
}

/** Permissions live on entryPoints in manifest version 2. A top-level permissions object is not that schema. */
export function manifestPermissions(manifest) {
  const oauth = [];
  const sandbox = [];
  for (const point of manifest?.entryPoints || []) {
    const permissions = point?.permissions || {};
    if (Array.isArray(permissions.oauth)) oauth.push(...permissions.oauth.map((host) => String(host).trim()).filter(Boolean));
    if (Array.isArray(permissions.sandbox)) sandbox.push(...permissions.sandbox.map((item) => String(item).trim()).filter(Boolean));
  }
  return {
    oauth,
    sandbox,
    undocumentedTopLevel: Boolean(manifest?.permissions && typeof manifest.permissions === "object")
  };
}

function distinctiveWord(brief) {
  const words = String(brief || "").toLowerCase().match(/\b[a-z][a-z0-9-]{3,}\b/g) || [];
  const skip = new Set(["add", "the", "and", "with", "from", "that", "this", "into", "your", "panel", "field", "feature", "using", "make", "insert"]);
  return words.find((word) => !skip.has(word)) || "";
}
