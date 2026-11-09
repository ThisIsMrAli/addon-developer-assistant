import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
  if (/\b(styled\s+text|create\s*text|add\s+(?:styled\s+)?text|heading|headline)\b/i.test(text)) needs.push("text");
  if (/\b(image|photo|picture)\b/i.test(text)) needs.push("image");
  if (/\b(spectrum|sp-textfield|sp-button)\b/i.test(text) || (/\bform\b/i.test(text) && /\bpanel\b/i.test(text))) needs.push("panel");
  if (/\boauth\b/i.test(text) || /\b(dropbox|clientstorage|network request)\b/i.test(text)) needs.push("oauth");
  return needs;
}

/** The pages and calls the agent must use. Nothing here is written into the project. */
export function implementationHandoff({ brief, pages = [], design = "" }) {
  const needs = briefNeeds(brief);
  const apis = [];
  if (needs.includes("text")) {
    apis.push({
      api: "editor.createText()",
      runtime: "document sandbox",
      note: "Create the text in code.js, set a style (font, size, or color), and append it to the document."
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
  if (needs.includes("oauth")) {
    apis.push({
      api: "addOnUISdk.app.oauth",
      runtime: "iframe runtime",
      note: "Declare permissions.oauth in manifest.json. clientStorage is addOnUISdk.instance.clientStorage."
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
 * The feature is real only when the code calls the APIs the brief needs, the project builds,
 * and a canned stub is absent. A failure is a list of problems. It does not mark the step done.
 */
export function verifyFeature({ dir, brief, build = true }) {
  const needs = briefNeeds(brief);
  const files = sourceFiles(dir);
  const text = files.map((file) => file.text).join("\n");
  const problems = [];
  if (!text.trim()) problems.push("No source was written.");
  if (isStub(text, dir)) problems.push("The add-on still has a canned stub (featureReady, a develop-feature field, or only the template's Create Rectangle).");
  if (needs.includes("text") && !/createText\s*\(/.test(text)) problems.push("Styled text needs editor.createText() in the document sandbox.");
  if (needs.includes("text") && !/fontSize|characterStyle|setStyle|\bfont\b|fill|color/i.test(text)) problems.push("Styled text needs a style: font, size, or color.");
  if (needs.includes("image") && !/addImage\s*\(|createImage\s*\(/.test(text)) problems.push("An image needs addImage() or createImage().");
  if (needs.includes("panel") && !/<sp-textfield\b|<sp-button\b|<sp-theme\b|sp-textfield|sp-button/i.test(text)) problems.push("A Spectrum form needs a Spectrum Web Component such as sp-textfield or sp-button.");
  if (needs.includes("oauth") && !manifestAllowsOauth(dir)) problems.push("Network or OAuth needs permissions.oauth in the manifest.");
  if (!needs.length) {
    const word = distinctiveWord(brief);
    if (word && !new RegExp(`\\b${word}\\b`, "i").test(text)) problems.push(`The code does not mention ${word} from the brief.`);
  }
  let built = { ok: true, skipped: true };
  if (build && !problems.length) {
    built = buildProject(dir);
    if (!built.ok) problems.push(built.error || "The add-on did not build.");
  }
  return { ok: problems.length === 0, problems, needs, build: built };
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

function isStub(text, dir) {
  if (/function\s+featureReady\s*\(/.test(text)) return true;
  if (/id=["']develop-feature["']/.test(text)) return true;
  const note = fs.existsSync(path.join(dir, "spectrum-note.txt")) || fs.existsSync(path.join(dir, "src", "spectrum-note.txt"));
  if (note && !/createText\s*\(|addImage\s*\(|createImage\s*\(|<sp-textfield\b/i.test(text)) return true;
  if (/Create Rectangle/.test(text) && !/createText\s*\(|addImage\s*\(|createImage\s*\(|<sp-textfield\b|<label\b/i.test(text)) return true;
  return false;
}

function distinctiveWord(brief) {
  const words = String(brief || "").toLowerCase().match(/\b[a-z][a-z0-9-]{3,}\b/g) || [];
  const skip = new Set(["add", "the", "and", "with", "from", "that", "this", "into", "your", "panel", "field", "feature", "using", "make", "insert"]);
  return words.find((word) => !skip.has(word)) || "";
}

function manifestAllowsOauth(dir) {
  for (const rel of ["src/manifest.json", "manifest.json"]) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      return /oauth/i.test(JSON.stringify(manifest.permissions || {}));
    } catch {
      return false;
    }
  }
  return false;
}
