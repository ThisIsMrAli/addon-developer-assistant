import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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
 * Write the feature the feasibility answer allowed.
 * The comment cites a sentence that is present in `evidence`, which the caller took from a fetched page.
 */
export function applyFeature({ dir, feature, design, evidence, page, brief }) {
  if (feature === "unsupported") {
    return { written: false, files: [], note: "Unsupported. No project file was changed." };
  }
  if (!evidence || !String(evidence).trim()) {
    throw new Error("Refusing to write. There is no evidence sentence from the docs.");
  }
  const root = addonRoot(dir);
  const files = [];
  if (feature === "iframe") {
    const html = findHtml(root);
    if (!html) throw new Error("The add-on has no index.html to hold iframe UI.");
    const label = labelFrom(brief);
    const next = insertField(fs.readFileSync(html, "utf8"), label, evidence, page);
    fs.writeFileSync(html, next);
    files.push(path.relative(dir, html));
    if (design === "swc") {
      const note = path.join(root, "spectrum-note.txt");
      fs.writeFileSync(note, `Design answer: Spectrum Web Components.\nThe implementation guide prefers them. This edit did not add a webpack pipeline when the template does not already have one.\nEvidence page: ${page}\n`);
      files.push(path.relative(dir, note));
    }
  } else if (feature === "sandbox") {
    const sandbox = findSandbox(root);
    if (!sandbox) {
      return { written: false, files: [], note: "The feature needs the document sandbox, and this add-on has no documentSandbox file. Nothing was written." };
    }
    const source = fs.readFileSync(sandbox, "utf8");
    if (!/createText|editor\./.test(evidence) && !/document sandbox/i.test(evidence)) {
      throw new Error("Refusing to write sandbox code. The evidence sentence does not mention the document sandbox.");
    }
    if (!source.includes("express-addon-develop:sandbox")) {
      fs.writeFileSync(sandbox, `${source.trim()}\n\n// express-addon-develop:sandbox\n// ${page}: ${evidence.replace(/\s+/g, " ").slice(0, 180)}\nexport function featureReady() {\n  return true;\n}\n`);
    }
    files.push(path.relative(dir, sandbox));
  }
  return { written: files.length > 0, files, note: files.length ? "Wrote the feature from the docs." : "Nothing to write." };
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

function addonRoot(dir) {
  if (fs.existsSync(path.join(dir, "src", "manifest.json"))) return path.join(dir, "src");
  return dir;
}

function findHtml(root) {
  const direct = path.join(root, "index.html");
  if (fs.existsSync(direct)) return direct;
  const nested = path.join(root, "ui", "index.html");
  if (fs.existsSync(nested)) return nested;
  return "";
}

function findSandbox(root) {
  for (const rel of ["sandbox/code.js", "sandbox/code.ts", "code.js"]) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) return full;
  }
  return "";
}

function labelFrom(brief) {
  const text = String(brief || "");
  const named = text.match(/\b(caption|title|label|note|name)\b/i);
  if (named) return named[1][0].toUpperCase() + named[1].slice(1).toLowerCase();
  return "Note";
}

function insertField(html, label, evidence, page) {
  if (html.includes('id="develop-feature"')) return html;
  const quote = String(evidence).replace(/\s+/g, " ").replace(/--/g, "—").slice(0, 160);
  const block = [
    `<!-- ${page}: ${quote} -->`,
    `<label for="develop-feature">${escapeHtml(label)}</label>`,
    `<input id="develop-feature" name="develop-feature" type="text" />`
  ].join("\n");
  if (html.includes("</body>")) return html.replace("</body>", `${block}\n</body>`);
  return `${html}\n${block}\n`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}
