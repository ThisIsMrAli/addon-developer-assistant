import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { checkJsSyntax, controlFlow, hasColumnPlacement, imageKeepsContentActive, imagePlacedWithContent, projectPanels, scanHtml, scanJs, storageKinds, stripComments } from "./code-scan.mjs";
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
 * Document text that stays inside the current page.
 * Page size is insertionParent.width and height (use-text.md).
 * The visual center is centerPointLocal, from boundsLocal (position-elements.md).
 * resize() with ResizeBehavior.contain fits both the width and the height (resize-elements.md).
 * Headings share one centre line and stack from the top of the page. A second column
 * starts only when that line cannot take another heading at a readable size.
 * An image sits below that column, or in the lower part of the page, and moves
 * when the next heading needs the column. It is never left on an earlier row.
 * createImageContainer runs in the afterAsyncCallback of keepContentActiveDuringAsync,
 * which is the form the Editor reference documents after loadBitmapImage.
 * The default 100pt text is left at the top-left origin, so a heading runs off the left edge.
 * Scaling a short word to the full page width makes it overflow the other edge.
 */
export const TEXT_INSIDE_PAGE = `import { editor, constants } from "express-document-sdk";

function fitInside(node, maxWidth, maxHeight) {
  const box = node.boundsLocal;
  if (box.width > maxWidth || box.height > maxHeight) {
    node.resize({
      width: maxWidth,
      height: maxHeight,
      behavior: constants.ResizeBehavior.contain,
      avoidScalingVisualDetailsIfPossible: false
    });
  }
}

const placedImages = [];
const FULL_MESSAGE = "The page is full. This stays at a readable size, so it was not added.";

function marginOf(page) {
  return Math.round(Math.min(page.width, page.height) * 0.08);
}

function gapFor(height) {
  return Math.max(8, Math.round(Math.max(height, 1) * 0.15));
}

function rectsOverlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5;
}

function onPage(rect, page, margin) {
  return rect.x >= margin - 0.5 && rect.y >= margin - 0.5 && rect.x + rect.width <= page.width - margin + 0.5 && rect.y + rect.height <= page.height - margin + 0.5;
}

function drop(node, slot) {
  const fitted = node.boundsLocal;
  const anchor = node.centerPointLocal || { x: fitted.x + fitted.width / 2, y: fitted.y + fitted.height / 2 };
  node.setPositionInParent(slot, anchor);
}

function releaseNode(node, page) {
  if (typeof node.removeFromParent === "function") node.removeFromParent();
  const list = page.children && page.children.items;
  if (Array.isArray(list)) {
    const at = list.indexOf(node);
    if (at >= 0) list.splice(at, 1);
  }
}

function selectionNode() {
  const selected = editor.context.selection && editor.context.selection[0];
  return selected && selected.boundsInParent ? selected : null;
}

function columnCenter(page, column) {
  if (column === 0) return page.width / 2;
  const side = Math.ceil(column / 2);
  const dir = column % 2 === 1 ? 1 : -1;
  return page.width / 2 + dir * side * (page.width * 0.25);
}

function columnBottom(page, x, self) {
  let bottom = 0;
  for (const item of page.children || []) {
    if (item === self || placedImages.includes(item) || !item.boundsInParent) continue;
    const box = item.boundsInParent;
    const cx = box.x + box.width / 2;
    if (Math.abs(cx - x) > 2) continue;
    if (box.y + box.height > bottom) bottom = box.y + box.height;
  }
  const selected = selectionNode();
  if (selected && selected !== self && selected.boundsInParent.y + selected.boundsInParent.height > bottom) {
    bottom = selected.boundsInParent.y + selected.boundsInParent.height;
  }
  return bottom;
}

function overlapsContent(rect, page, self) {
  for (const item of page.children || []) {
    if (item === self || placedImages.includes(item) || !item.boundsInParent) continue;
    if (rectsOverlap(rect, item.boundsInParent)) return true;
  }
  const selected = selectionNode();
  if (selected && selected !== self && rectsOverlap(rect, selected.boundsInParent)) return true;
  return false;
}

function slotInColumn(node, page, margin, column) {
  const fitted = node.boundsLocal;
  const gap = gapFor(fitted.height);
  const x = columnCenter(page, column);
  const bottom = columnBottom(page, x, node);
  const y = (bottom > 0 ? bottom + gap : margin) + fitted.height / 2;
  const rect = { x: x - fitted.width / 2, y: y - fitted.height / 2, width: fitted.width, height: fitted.height };
  if (!onPage(rect, page, margin)) return null;
  if (overlapsContent(rect, page, node)) return null;
  return { x, y, rect };
}

function shrinkToward(node, minHeight) {
  const box = node.boundsLocal;
  if (box.height <= minHeight + 0.5) return false;
  const nextH = Math.max(minHeight, Math.round(box.height * 0.82));
  if (nextH >= box.height - 0.5) return false;
  const nextW = Math.max(8, Math.round(box.width * (nextH / box.height)));
  node.resize({
    width: nextW,
    height: nextH,
    behavior: constants.ResizeBehavior.contain,
    avoidScalingVisualDetailsIfPossible: false
  });
  return true;
}

function moveImageBelow(image, page, margin, reserved) {
  const gap = 8;
  const minH = 64;
  const targetTop = reserved.y + reserved.height + gap;
  const available = page.height - margin - targetTop;
  if (available < minH - 0.5) return false;
  const box = image.boundsLocal;
  const maxW = Math.max(8, page.width - margin * 2);
  if (box.height > available || box.width > maxW) {
    const scale = Math.min(maxW / box.width, available / box.height);
    const nextH = Math.round(box.height * scale);
    const nextW = Math.round(box.width * scale);
    if (nextH < minH - 0.5 || nextW < 8) return false;
    image.resize({
      width: nextW,
      height: nextH,
      behavior: constants.ResizeBehavior.contain,
      avoidScalingVisualDetailsIfPossible: false
    });
  }
  const fitted = image.boundsLocal;
  const x = page.width / 2;
  const rect = { x: x - fitted.width / 2, y: targetTop, width: fitted.width, height: fitted.height };
  if (!onPage(rect, page, margin) || rectsOverlap(rect, reserved)) return false;
  for (const item of page.children || []) {
    if (item === image || placedImages.includes(item) || !item.boundsInParent) continue;
    if (rectsOverlap(rect, item.boundsInParent)) return false;
  }
  for (const other of placedImages) {
    if (other === image) continue;
    if (other.boundsInParent && rectsOverlap(rect, other.boundsInParent)) return false;
  }
  drop(image, { x, y: targetTop + fitted.height / 2 });
  return true;
}

function parkImages(page, margin, reserved) {
  for (const image of placedImages) {
    if (!image.boundsInParent || !rectsOverlap(reserved, image.boundsInParent)) continue;
    if (!moveImageBelow(image, page, margin, reserved)) return false;
  }
  return placedImages.every((image) => !image.boundsInParent || !rectsOverlap(reserved, image.boundsInParent));
}

function restoreSize(node, fitted) {
  const box = node.boundsLocal;
  if (Math.abs(box.width - fitted.width) < 0.5 && Math.abs(box.height - fitted.height) < 0.5) return;
  node.resize({
    width: fitted.width,
    height: fitted.height,
    behavior: constants.ResizeBehavior.contain,
    avoidScalingVisualDetailsIfPossible: false
  });
}

function placeHeading(node, page) {
  const margin = marginOf(page);
  const maxWidth = Math.max(32, page.width - margin * 2);
  const maxHeight = Math.max(32, page.height - margin * 2);
  fitInside(node, maxWidth, maxHeight);
  const fitted = { width: node.boundsLocal.width, height: node.boundsLocal.height };
  const minH = Math.round(24 * 1.2);
  for (let column = 0; column < 3; column += 1) {
    restoreSize(node, fitted);
    for (let guard = 0; guard < 8; guard += 1) {
      const slot = slotInColumn(node, page, margin, column);
      if (slot && parkImages(page, margin, slot.rect)) {
        drop(node, slot);
        return { ok: true, message: "" };
      }
      if (!shrinkToward(node, minH)) break;
    }
  }
  releaseNode(node, page);
  return { ok: false, message: FULL_MESSAGE };
}

function contentBottom(page, self) {
  let bottom = 0;
  for (const item of page.children || []) {
    if (item === self || placedImages.includes(item) || !item.boundsInParent) continue;
    const box = item.boundsInParent;
    if (box.y + box.height > bottom) bottom = box.y + box.height;
  }
  const selected = selectionNode();
  if (selected && selected !== self && selected.boundsInParent.y + selected.boundsInParent.height > bottom) {
    bottom = selected.boundsInParent.y + selected.boundsInParent.height;
  }
  return bottom;
}

function placeImageNode(image, page) {
  const margin = marginOf(page);
  const maxWidth = Math.max(64, page.width - margin * 2);
  const bottom = contentBottom(page, image);
  const gap = 12;
  if (bottom > 0) {
    const top = bottom + gap;
    const available = page.height - margin - top;
    if (available < 64) {
      releaseNode(image, page);
      return { ok: false, message: FULL_MESSAGE };
    }
    fitInside(image, maxWidth, available);
    const fitted = image.boundsLocal;
    drop(image, { x: page.width / 2, y: top + fitted.height / 2 });
    return { ok: true, message: "" };
  }
  const maxHeight = Math.max(64, (page.height - margin * 2) * 0.5);
  fitInside(image, maxWidth * 0.7, maxHeight);
  const fitted = image.boundsLocal;
  drop(image, { x: page.width / 2, y: page.height - margin - fitted.height / 2 });
  return { ok: true, message: "" };
}

export function addHeading(heading) {
  const page = editor.context.insertionParent;
  const textNode = editor.createText(heading);
  const cap = Math.min(72, Math.round(page.width / 16));
  page.children.append(textNode);
  textNode.fullContent.applyCharacterStyles(
    { fontSize: cap, color: { red: 0.1, green: 0.1, blue: 0.1, alpha: 1 } },
    { start: 0, length: heading.length }
  );
  const placed = placeHeading(textNode, page);
  return placed.message;
}

export async function addImage(blob) {
  const page = editor.context.insertionParent;
  const bitmap = await editor.loadBitmapImage(blob);
  let placed = { ok: false, message: FULL_MESSAGE };
  await editor.keepContentActiveDuringAsync(
    page,
    async () => {},
    () => {
      const image = editor.createImageContainer(bitmap, { initialSize: { width: 256, height: 256 } });
      page.children.append(image);
      placed = placeImageNode(image, page);
      if (placed.ok) placedImages.push(image);
    }
  );
  return placed.message || "";
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
      note: "Create the text in code.js. Read the page size from editor.context.insertionParent (use-text.md). Cap the font (Math.min(72, page width / 16)) and call resize() with constants.ResizeBehavior.contain for both width and height, and only when boundsLocal is larger than the page minus an 8% margin (resize-elements.md). Stack headings on one centre line with setPositionInParent, using centerPointLocal from boundsLocal (position-elements.md). The next heading goes below the previous one, or below the selection, using boundsInParent. Open a second column, aligned on its own centre, only when the first column cannot take another heading at a readable size (about 24px). Do not shrink a heading to a few pixels, and do not drop it onto an earlier row. When nothing readable fits, do not add the node, and say the page is full. Do not leave the default 100pt text on the top-left origin, do not scale a short heading to the full page width, and do not stack every heading on the same point. An empty field shows \"Type a heading first.\" and adds nothing.",
      snippet: TEXT_INSIDE_PAGE
    });
  }
  if (needs.includes("image")) {
    apis.push({
      api: "editor.loadBitmapImage() and editor.createImageContainer()",
      runtime: "document sandbox",
      note: "Build the image in the document sandbox. Adobe's Editor reference (keepContentActiveDuringAsync, Example 2, load an image from a Blob) awaits editor.loadBitmapImage(blob), then calls editor.keepContentActiveDuringAsync(insertionParent, async () => {}, afterAsyncCallback). createImageContainer runs in that afterAsyncCallback, not in the open after the await and not inside the async lambda. editor.queueAsyncEdit(callback) is the other accepted form. Fit the image with resize() and place it below the heading column, using boundsInParent, so it does not cover a heading (position-elements.md, resize-elements.md). A later heading continues the same centre line and the image moves down to make room. A centered addImage() covers the heading under it. A panel call such as this._sandboxProxy.addImage(blob) is a sandbox call, not addOnUISdk.app.document.addImage.",
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
  const sandboxScans = [];
  const codeFiles = [];
  for (const file of files) {
    const rel = path.relative(dir, file.file).split(path.sep).join("/");
    if (/\.(html?)$/i.test(file.file)) continue;
    if (/\.(json)$/i.test(file.file)) continue;
    const scanned = scanJs(file.text);
    const syntax = /\.(mjs|cjs|jsx?|tsx?)$/i.test(file.file) ? checkJsSyntax(file.file) : scanned.syntax;
    if (syntax) problems.push(`${rel} does not parse. ${syntax}`);
    const role = fileRole(rel, manifest);
    if (role === "sandbox") sandboxScans.push({ ...scanned, text: file.text });
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
    if (created.length && !textStaysOnPage(sandboxScans)) {
      problems.push("Inserted text has no positioning or bounds. Read editor.context.insertionParent width and height (use-text.md), cap the font, and fit both width and height with resize() only when the text is larger than the page minus a margin (resize-elements.md). Stack headings on one centre line with setPositionInParent using boundsLocal or centerPointLocal (position-elements.md), and place the next one below the previous heading or the selection using boundsInParent so consecutive headings do not overlap. When that column runs out of room, align a second column or stop at a readable size instead of shrinking to a few pixels or clamping onto an earlier row. A fixed font size at the top-left origin runs off the left edge, and scaling a short heading to the full page width overflows the other edge.");
    }
  }
  if (needs.includes("image")) {
    const created = named(calls, /(^|\.)(addImage|createImage|createImageContainer|loadBitmapImage)$/);
    if (!created.length) problems.push("An image needs an addImage(), createImageContainer(), or loadBitmapImage() call.");
    else {
      if (!imageKeepsContentActive(codeFiles)) problems.push("createImageContainer() has to run in the afterAsyncCallback of editor.keepContentActiveDuringAsync(), as the Editor reference shows for loadBitmapImage (Example 2, load an image from a Blob). The async lambda must not edit the document. editor.queueAsyncEdit() is the other accepted form. Do not call createImageContainer() in the open after await loadBitmapImage().");
      if (!imagePlacedWithContent(codeFiles)) problems.push("An image needs the same free-space placement as a heading. Fit it to the page width and height minus a margin, then place it below existing content with boundsInParent so it does not cover a heading. A panel this._sandboxProxy.addImage() call is the sandbox API, not addOnUISdk.app.document.addImage. Centering the image on the page covers what is already there.");
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
  for (const name of sandboxApiMismatches(codeFiles)) {
    problems.push(`The panel calls ${name}, but the document sandbox does not expose ${name} through runtime.exposeApi.`);
  }
  let built = { ok: true, skipped: true };
  if (build && !problems.length) {
    built = buildProject(dir);
    if (!built.ok) problems.push(built.error || "The add-on did not build.");
  }
  return { ok: problems.length === 0, problems, needs, build: built, permissions };
}

function textStaysOnPage(scans) {
  return scans.some((scan) => {
    const calls = scan.calls || [];
    if (!calls.some((call) => /(^|\.)createText$/.test(call))) return false;
    const words = new Set(scan.words || []);
    const source = String(scan.text || "");
    const positioned = calls.some((call) => /(^|\.)setPositionInParent$/.test(call));
    const bounds = words.has("boundsLocal") || words.has("boundsInParent") || words.has("centerPointLocal");
    const page = words.has("insertionParent") || words.has("artboards") || words.has("currentPage");
    const bothAxes = /resize\s*\(\s*\{[^}]*\bwidth\b[^}]*\bheight\b[^}]*\}/.test(source) || /resize\s*\(\s*\{[^}]*\bheight\b[^}]*\bwidth\b[^}]*\}/.test(source);
    const capped = /Math\.min\s*\(\s*\d+/.test(source) && words.has("fontSize");
    const onlyShrink = /width\s*>\s*maxWidth/.test(source) && /height\s*>\s*maxHeight/.test(source);
    const stacked = (words.has("children") || words.has("selection")) && words.has("boundsInParent");
    const overflow = hasColumnPlacement(source);
    return positioned && bounds && page && bothAxes && capped && onlyShrink && stacked && overflow;
  });
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
