/**
 * Fill the locked listing pages with what the add-on really does (read from its code) and phrases
 * that already exist in its panel, and drop image tags whose files are not there. The panel pictures
 * are real captures of the built panel (panel-capture.mjs). Nothing is drawn in their place.
 * The stylesheet and the layout stay locked.
 */
import fs from "node:fs";
import path from "node:path";
import { addonCorpus } from "../../../express-addon-review/scripts/lib/listing.mjs";
import { panelMarkup, parseSource, scanHtml } from "./code-scan.mjs";
import { exposedSandboxMethods } from "./standin.mjs";

const BOILERPLATE = /^(get started|create rectangle|hello world|welcome|click me|javascript|swc-javascript|adobe creative cloud web add-on\.?)$/i;
const PLACEHOLDER = /^(loading\b|please wait\b|placeholder\b)/i;

export function phrasesFromAddon(dir) {
  const corpus = addonCorpus(dir);
  const htmlPhrases = [];
  const metaPhrases = [];
  const consider = (bucket, raw) => {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 80) return;
    if (/[{}<>]/.test(text)) return;
    if (BOILERPLATE.test(text) || PLACEHOLDER.test(text) || /adobe creative cloud web add-on/i.test(text) || /^get started$/i.test(text)) return;
    if (!corpus.includes(text.toLowerCase())) return;
    if (htmlPhrases.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    if (metaPhrases.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    bucket.push(text);
  };
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
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.html?$/i.test(entry.name)) {
        for (const piece of scanHtml(fs.readFileSync(full, "utf8")).phrases || []) consider(htmlPhrases, piece);
      } else if (/\.(jsx?|tsx?|mjs)$/i.test(entry.name)) {
        const panel = panelMarkup(fs.readFileSync(full, "utf8"), entry.name);
        const pieces = panel.phrases?.length ? panel.phrases : panel.text.split(/(?<=[.!?])\s+/);
        for (const piece of pieces) consider(htmlPhrases, piece);
      } else if (/(^|\/)manifest\.json$/i.test(full.replaceAll("\\", "/"))) {
        let manifest = {};
        try { manifest = JSON.parse(fs.readFileSync(full, "utf8")); } catch { manifest = {}; }
        for (const key of ["name", "summary", "description"]) {
          if (typeof manifest[key] === "string") consider(metaPhrases, manifest[key]);
        }
      }
    }
  };
  walk(dir);
  return [...htmlPhrases, ...metaPhrases];
}

const KEYWORD_SKIP = new Set(["the", "and", "for", "with", "add", "adds", "from", "that", "this", "into", "your", "both", "only", "via", "not", "now", "was", "are", "two", "user", "sign", "signs", "then", "onto", "page", "panel", "button", "field", "using", "use", "its", "has", "have", "when", "will", "can", "you", "our", "new", "all", "spectrum", "type", "pick", "between", "sessions", "places", "shows", "lists", "saves", "what", "enter", "current"]);
const API_WORD = /^(sp-|createrenditions|clientstorage|addimage|createtext|createrectangle|sandbox|iframe|oauth|runtime|textfield|spbutton)/i;

const PROVIDERS = [
  [/dropbox/i, "Dropbox"],
  [/googleapis|accounts\.google|drive\.google/i, "Google Drive"],
  [/onedrive|graph\.microsoft|login\.microsoftonline/i, "OneDrive"],
  [/\bbox\.com\b/i, "Box"],
  [/figma/i, "Figma"],
  [/github/i, "GitHub"],
  [/notion/i, "Notion"],
  [/slack/i, "Slack"]
];

function sourceFiles(dir) {
  const files = [];
  const walk = (folder) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", "dist", "build", "out", "review-output"].includes(entry.name)) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(m?jsx?|tsx?|html?|json)$/i.test(entry.name) && fs.statSync(full).size < 1_000_000) files.push({ rel: path.relative(dir, full), text: fs.readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return files;
}

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1").replace(/<!--[\s\S]*?-->/g, " ");

/**
 * Sandbox facts come from the methods runtime.exposeApi actually publishes, and from the functions
 * those methods call. A helper that is never exposed (the image half of a copied snippet, when the
 * panel only publishes addHeading) is not a feature of the add-on. A file that never calls
 * exposeApi is counted whole, because its exports are the API.
 */
function factSource(file) {
  const text = String(file.text || "");
  if (/\.json$/i.test(file.rel || "")) return "";
  if (!/express-document-sdk|\bexposeApi\b|\beditor\./.test(text)) return text;
  if (!/\bexposeApi\b/.test(text)) return text;
  return reachableSandboxSource(text);
}

function clientStorageFact(code) {
  const keys = [...code.matchAll(/setItem\(\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]);
  const storesNotes = keys.some((key) => /notes?/i.test(key)) || /setItem\([^)]{0,80}\bnotes?\b/i.test(code);
  if (storesNotes) return "Keeps your notes between sessions";
  if (/token|oauth|authorize|session/i.test(code)) return "Remembers your sign-in between sessions";
  return "Remembers what you enter between sessions";
}

function reachableSandboxSource(text) {
  const parsed = parseSource("sandbox.js", text);
  if (!parsed.ast) return text;
  const exposed = exposedSandboxMethods(text);
  if (!exposed.length) return "";
  const bodies = new Map();
  const addBody = (name, node) => {
    if (!name || !node || typeof node.start !== "number") return;
    const list = bodies.get(name) || [];
    list.push(node);
    bodies.set(name, list);
  };
  const isFn = (node) => node && (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression" || node.type === "FunctionDeclaration");
  visitAst(parsed.ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id?.name) addBody(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && isFn(node.init)) addBody(node.id.name, node.init);
    if ((node.type === "ClassMethod" || node.type === "ClassProperty") && !node.static && node.kind !== "constructor" && node.key?.type === "Identifier" && !node.computed && (node.type === "ClassMethod" || isFn(node.value))) addBody(node.key.name, node.type === "ClassMethod" ? node : node.value);
    if (node.type === "AssignmentExpression" && node.left?.type === "MemberExpression" && !node.left.computed && isFn(node.right)) {
      const key = node.left.property?.name;
      if (key) addBody(key, node.right);
    }
  });
  const seen = new Set();
  const ranges = [];
  const take = (name) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    for (const node of bodies.get(name) || []) {
      ranges.push([node.start, node.end]);
      visitAst(node, (inner) => {
        if (inner.type !== "CallExpression") return;
        const callee = inner.callee;
        if (callee?.type === "Identifier") take(callee.name);
        if (callee?.type === "MemberExpression" && !callee.computed && callee.property?.type === "Identifier") take(callee.property.name);
      });
    }
  };
  for (const name of exposed) take(name);
  if (!ranges.length) return "";
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges.map(([start, end]) => text.slice(start, end)).join("\n");
}

function visitAst(node, fn) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => visitAst(item, fn));
    else if (value && typeof value === "object" && typeof value.type === "string") visitAst(value, fn);
  }
}

/**
 * What the add-on does, read from its code, as short sentences for the listing. Each fact is
 * there only because the matching API call (or manifest permission) is in the add-on.
 */
export function featureFacts(dir) {
  const files = sourceFiles(dir);
  const code = files.filter((file) => !/\.json$/i.test(file.rel)).map((file) => stripComments(factSource(file))).join("\n");
  let manifest = {};
  const manifestFile = files.find((file) => /(^|\/)manifest\.json$/i.test(file.rel.replaceAll("\\", "/")));
  try { manifest = manifestFile ? JSON.parse(manifestFile.text) : {}; } catch { manifest = {}; }
  const ui = phrasesFromAddon(dir).join(" ").toLowerCase();
  const facts = [];
  const nouns = [];
  const makesText = /\.createText\s*\(/.test(code) || /document\.addText\b/.test(code);
  const makesImage = /\.(createImageContainer|loadBitmapImage)\s*\(/.test(code) || /document\.add(Animated)?Image\s*\(/.test(code);
  if (makesText) {
    const noun = /\bheadings?\b/.test(ui) ? "heading" : /\bcaptions?\b/.test(ui) ? "caption" : /\btitles?\b/.test(ui) ? "title" : /\bnotes?\b/.test(ui) ? "note" : "text";
    const typed = /<(input|textarea|sp-textfield|sp-search)\b|textfield|\.value\b/i.test(code);
    facts.push(`Adds the ${noun === "text" ? "text" : noun} you type to the page`);
    nouns.push(noun === "text" ? "text" : `${noun}s`);
    if (!typed) facts[facts.length - 1] = `Adds ${noun === "text" ? "text" : `a ${noun}`} to the page`;
  }
  if (makesImage) {
    facts.push(/<input[^>]*type=["']?file|showOpenFilePicker|type:\s*["']file/i.test(code) ? "Places an image you pick on the page" : "Places an image on the page");
    nouns.push("images");
  }
  if ((makesText || makesImage) && /boundsInParent/.test(code) && /insertionParent/.test(code)) facts.push("Keeps every item inside the page, clear of what is already there");
  if (/\.createRenditions\s*\(/.test(code)) {
    const format = code.match(/RenditionFormat\.(png|jpg|pdf|mp4|pptx)\b/i)?.[1] || code.match(/["']image\/(png|jpeg)["']/i)?.[1] || code.match(/format:\s*["'](png|jpg|pdf|mp4)["']/i)?.[1] || "";
    const kind = format ? `a ${format.toLowerCase() === "jpeg" ? "JPG" : format.toUpperCase()}` : "an image";
    const preview = /URL\.createObjectURL|\.src\s*=|<img\b|preview/i.test(code);
    const download = /\.download\s*=|download\s*\(|\bdownload=/i.test(code);
    facts.push(`Exports the current page as ${kind}${preview ? " with a preview" : ""}${download ? " you can download" : ""}`);
    nouns.push("export", format ? format.toLowerCase() : "rendition");
  }
  if (/oauth\.authorize|authorizeWithOwnRedirect|oauth\.authorize\b/.test(code)) {
    const hosts = JSON.stringify(manifest?.requiredPermissions?.oauth || []) + code.match(/https:\/\/[a-z0-9.-]+/gi)?.join(" ");
    const provider = PROVIDERS.find(([pattern]) => pattern.test(hosts))?.[1] || "";
    facts.push(provider ? `Signs in to ${provider} from the panel` : "Signs in to your account from the panel");
    if (provider) nouns.push(provider.toLowerCase());
    if (/list_folder|listFiles|files\.list|\/files\b|\.entries\b/i.test(code)) facts.push(provider ? `Lists your ${provider} files` : "Lists your files");
  }
  if (/clientStorage/.test(code)) facts.push(clientStorageFact(code));
  if (/\bnotes?\b/.test(ui) && !nouns.includes("notes")) nouns.push("notes");
  return { facts: [...new Set(facts)], nouns };
}

function sentence(text) {
  const clean = String(text || "").trim().replace(/\s+/g, " ");
  if (!clean) return "";
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

export function listingFrom({ name, brief = "", description = "", dir = "" }) {
  const { facts, nouns } = dir ? featureFacts(dir) : { facts: [], nouns: [] };
  const phrases = dir ? phrasesFromAddon(dir) : [];
  const own = String(name || "").trim().toLowerCase();
  const specific = phrases.filter((phrase) => !BOILERPLATE.test(phrase) && phrase.toLowerCase() !== own);
  const usable = description && !/adobe creative cloud web add-on\.?$/i.test(String(description).trim()) ? String(description).trim() : "";
  const summary = facts.length ? sentence(facts[0]) : usable ? sentence(usable) : specific[0] ? sentence(specific[0]) : sentence(`${name || "This add-on"} works in the add-on panel`);
  const body = facts.length ? facts.slice(0, 4).map(sentence).join(" ") : usable ? sentence(usable) : specific.slice(0, 2).map(sentence).join(" ");
  const text = `${name}. ${body}`.replace(/\s+/g, " ").trim();
  const words = `${nouns.join(" ")} ${specific.join(" ")} ${name}`.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) || [];
  const keywords = [...new Set(words.filter((word) => !KEYWORD_SKIP.has(word) && !API_WORD.test(word)))].slice(0, 6);
  return { name, summary, description: text, keywords, facts, brief: String(brief || "") };
}

const PANEL_SHOTS = ["panel-back.png", "panel-front.png", "panel-mid.png", "panel-third.png"];

/**
 * Fills the listing pages. `shotsDir` holds real panel captures from panel-capture.mjs. Without
 * them nothing is written and the reason is returned: a drawn panel is not a picture of the add-on.
 */
export function fillListingDir(listingDir, addonDir, { shotsDir = "", shotsError = "" } = {}) {
  const phrases = phrasesFromAddon(addonDir);
  const { facts } = featureFacts(addonDir);
  if (!phrases.length) return { ok: false, error: "The add-on has no phrase the listing can quote. The template's Get Started text is not a feature." };
  const files = fs.readdirSync(listingDir).filter((name) => name.endsWith(".html"));
  if (!files.length) return { ok: false, error: "prepare-listing did not write any pages." };
  const shots = PANEL_SHOTS.filter((name) => shotsDir && fs.existsSync(path.join(shotsDir, name)) && isPng(path.join(shotsDir, name)));
  if (!shots.length) {
    return { ok: false, error: shotsError || "No real picture of the panel was taken, so the listing images were not made. A drawn stand-in is not used." };
  }
  for (const name of shots) fs.copyFileSync(path.join(shotsDir, name), path.join(listingDir, name));
  const slots = slotTexts(phrases);
  for (const name of files) fillPage(path.join(listingDir, name), slots);
  const written = files.map((name) => fs.readFileSync(path.join(listingDir, name), "utf8")).join("\n");
  if (/Get Started/i.test(written)) return { ok: false, error: "The listing still shows the template's Get Started text. The screenshots are not done." };
  return { ok: true, phrases, facts, slots, shots };
}

function isPng(file) {
  const head = Buffer.alloc(8);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
  return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
}

/**
 * Each slot on the pictures gets a different phrase quoted from the panel (the render lint only
 * accepts quoted text). The add-on's name is used at most once. A slot with nothing left is removed.
 */
function slotTexts(phrases) {
  const used = new Set();
  const take = (list) => {
    for (const item of list) {
      const key = String(item).toLowerCase().replace(/[.!?]$/, "");
      if (!item || used.has(key)) continue;
      used.add(key);
      return item;
    }
    return "";
  };
  const short = phrases.filter((phrase) => phrase.split(/\s+/).length <= 5);
  const long = phrases.filter((phrase) => phrase.split(/\s+/).length > 3);
  const kicker = take(short) || take(phrases);
  const headline = take(phrases);
  const line = take(long) || take(phrases);
  const pills = [];
  for (let n = 0; n < 3; n += 1) {
    const pill = take(short);
    if (pill) pills.push(pill);
  }
  return { kicker, headline, line, pills };
}

function fillPage(file, slots) {
  let html = fs.readFileSync(file, "utf8");
  const swap = (marker, value) => {
    if (value) {
      html = html.replace(marker, escapeHtml(value));
      return;
    }
    const pattern = new RegExp(`<([a-z0-9]+)([^>]*)>\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</\\1>`, "i");
    html = pattern.test(html) ? html.replace(pattern, "") : html.replace(marker, "");
  };
  swap("Short phrase from the UI", slots.kicker);
  swap("Real count or feature", slots.headline);
  swap("One sentence already written in the add-on.", slots.line);
  let pill = 0;
  html = html.replace(/<span>Fact<\/span>\s*/g, () => {
    const text = slots.pills[pill];
    pill += 1;
    return text ? `<span>${escapeHtml(text)}</span>\n        ` : "";
  });
  html = html.replace(/>Fact</g, () => {
    const text = slots.pills[pill];
    pill += 1;
    return text ? `>${escapeHtml(text)}<` : "><";
  });
  const dir = path.dirname(file);
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = tag.match(/\ssrc="([^"]*)"/i)?.[1] || "";
    if (!src || /^(https?:|data:|\/\/)/i.test(src)) return "";
    const full = path.resolve(dir, decodeURI(src.split(/[?#]/)[0]));
    return fs.existsSync(full) ? tag : "";
  });
  fs.writeFileSync(file, html);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}
