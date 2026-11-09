import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { checkJsSyntax, scanHtml, scanJs, stripComments } from "./code-scan.mjs";
import { buildProject } from "./package-addon.mjs";

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
  const result = spawnSync("npx", ["--yes", "@adobe/create-ccweb-add-on", name, "--template", template, "--analytics", "off"], {
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
 * resize() with ResizeBehavior.contain sets the font size from that width (resize-elements.md).
 * The default 100pt text is left at the top-left origin, so a heading runs off the left edge.
 */
export const TEXT_INSIDE_PAGE = `import { editor, constants } from "express-document-sdk";

export function addHeading(heading) {
  const page = editor.context.insertionParent;
  const textNode = editor.createText(heading);
  const margin = Math.round(Math.min(page.width, page.height) * 0.08);
  const maxWidth = Math.max(32, page.width - margin * 2);
  page.children.append(textNode);
  textNode.fullContent.applyCharacterStyles(
    { color: { red: 0.1, green: 0.1, blue: 0.1, alpha: 1 } },
    { start: 0, length: heading.length }
  );
  textNode.resize({
    width: maxWidth,
    behavior: constants.ResizeBehavior.contain,
    avoidScalingVisualDetailsIfPossible: false
  });
  const box = textNode.boundsLocal;
  textNode.setPositionInParent(
    { x: page.width / 2, y: page.height / 2 },
    textNode.centerPointLocal || { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  );
}
`;

/** The pages and calls the agent must use. Nothing here is written into the project. */
export function implementationHandoff({ brief, pages = [], design = "" }) {
  const needs = briefNeeds(brief);
  const apis = [];
  if (needs.includes("text")) {
    apis.push({
      api: "editor.createText()",
      runtime: "document sandbox",
      note: "Create the text in code.js. Read the page size from editor.context.insertionParent (use-text.md). Fit the font with resize() and constants.ResizeBehavior.contain to that width minus a margin (resize-elements.md). Center it with setPositionInParent, using centerPointLocal from boundsLocal so the visual box stays inside the page (position-elements.md). Do not leave the default 100pt text on the top-left origin.",
      snippet: TEXT_INSIDE_PAGE
    });
  }
  if (needs.includes("image")) {
    apis.push({
      api: "addOnUISdk.app.document.addImage()",
      runtime: "iframe runtime",
      note: "Insert the image from the panel. Document edits that follow stay in the sandbox."
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
  if (!files.length) problems.push("No source was written.");
  const calls = [];
  const sandboxScans = [];
  for (const file of files) {
    const rel = path.relative(dir, file.file).split(path.sep).join("/");
    if (/\.(html?)$/i.test(file.file)) continue;
    if (/\.(json)$/i.test(file.file)) continue;
    const scanned = scanJs(file.text);
    const syntax = /\.(mjs|cjs|jsx?|tsx?)$/i.test(file.file) ? checkJsSyntax(file.file) : scanned.syntax;
    if (syntax) problems.push(`${rel} does not parse. ${syntax}`);
    const role = fileRole(rel, manifest);
    if (role === "sandbox") sandboxScans.push(scanned);
    for (const call of scanned.calls) calls.push({ call, rel, role, text: file.text });
  }
  const html = files.filter((file) => /\.html?$/i.test(file.file)).map((file) => ({ ...scanHtml(file.text), rel: path.relative(dir, file.file) }));
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
      problems.push("Inserted text has no positioning or bounds. Read editor.context.insertionParent width and height (use-text.md), fit the font with resize() to that width minus a margin (resize-elements.md), and center it with setPositionInParent using boundsLocal or centerPointLocal (position-elements.md). A fixed font size at the top-left origin runs off the left edge.");
    }
  }
  if (needs.includes("image") && !named(calls, /(^|\.)(addImage|createImage)$/).length) {
    problems.push("An image needs an addImage() or createImage() call.");
  }
  if (needs.includes("panel")) {
    const tags = html.flatMap((page) => page.tags);
    if (!tags.some((tag) => tag === "sp-textfield" || tag === "sp-button" || tag === "sp-theme")) {
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
    const authorizeFiles = new Set(named(calls, /(^|\.)authorize$/).map((item) => item.rel));
    for (const rel of authorizeFiles) {
      const file = files.find((item) => path.relative(dir, item.file).split(path.sep).join("/") === rel);
      if (file && !/\bcatch\b/.test(stripComments(file.text))) problems.push("authorize() needs a catch. An unhandled rejection is not a finished sign-in.");
    }
  }
  if (needs.includes("storage")) {
    const stores = named(calls, /(^|\.)(getItem|setItem|removeItem)$/);
    const client = stores.some((item) => /clientStorage/.test(item.call));
    const local = stores.some((item) => /^localStorage\./.test(item.call));
    if (!client) problems.push(local ? "Token storage needs addOnUISdk.instance.clientStorage. localStorage is not that API." : "Token storage needs addOnUISdk.instance.clientStorage.");
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
  if (/\bthrow\b/.test(code) && !/\bcatch\b/.test(code)) problems.push("The code throws and nothing catches it.");
  const visible = html.some((page) => page.text || page.controls);
  if (html.length && !visible && (needs.includes("panel") || needs.length)) problems.push("The panel is blank: no text and no control.");
  if (!needs.length) {
    const word = distinctiveWord(brief);
    if (word && !new RegExp(`\\b${word}\\b`, "i").test(code)) problems.push(`The code does not mention ${word} from the brief.`);
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
    const positioned = calls.some((call) => /(^|\.)setPositionInParent$/.test(call));
    const bounds = words.has("boundsLocal") || words.has("boundsInParent") || words.has("centerPointLocal");
    const page = words.has("insertionParent") || words.has("artboards") || words.has("currentPage");
    const fitted = calls.some((call) => /(^|\.)resize$/.test(call)) && page && words.has("width");
    const fontFromPage = words.has("fontSize") && page && words.has("width");
    return positioned && bounds && (fitted || fontFromPage);
  });
}

export function applyManifestName(dir, name) {
  const wanted = String(name || "").trim();
  if (!wanted) return "";
  for (const rel of ["src/manifest.json", "manifest.json"]) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.name = wanted;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return file;
  }
  return "";
}

function writeFixture(dir, template) {
  const src = path.join(dir, "src");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: path.basename(dir), private: true, description: "Local fixture.", scripts: {} }, null, 2)}\n`);
  fs.writeFileSync(path.join(src, "manifest.json"), `${JSON.stringify({
    name: path.basename(dir),
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
