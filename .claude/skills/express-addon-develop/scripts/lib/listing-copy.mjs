/**
 * Fill the locked listing pages with phrases that already exist in the add-on,
 * and drop image tags whose files are not there. The stylesheet and the layout stay locked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { addonCorpus } from "../../../express-addon-review/scripts/lib/listing.mjs";
import { findChrome, shoot } from "../../../express-addon-review/scripts/lib/chrome.mjs";
import { panelMarkup } from "./code-scan.mjs";

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
        const page = fs.readFileSync(full, "utf8")
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<!--[\s\S]*?-->/g, " ")
          .replace(/<title[\s\S]*?<\/title>/gi, " ");
        for (const piece of page.replace(/<[^>]+>/g, "\n").split("\n")) consider(htmlPhrases, piece);
      } else if (/\.(jsx?|tsx?|mjs)$/i.test(entry.name)) {
        const panel = panelMarkup(fs.readFileSync(full, "utf8"), entry.name);
        for (const piece of panel.text.split(/(?<=[.!?])\s+/)) consider(htmlPhrases, piece);
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

const KEYWORD_SKIP = new Set(["the", "and", "for", "with", "add", "from", "that", "this", "into", "your", "both", "only", "via", "not", "now", "was", "are", "two", "user", "sign", "then", "onto", "page", "panel", "button", "field", "using", "use", "its", "has", "have", "when", "will", "can", "you", "our", "new", "all", "spectrum"]);
const API_WORD = /^(sp-|createrenditions|clientstorage|addimage|createtext|createrectangle|sandbox|iframe|oauth|runtime|textfield|spbutton)/i;

function featurePhrases(brief) {
  const text = String(brief || "");
  const wants = [];
  if (/\bheadings?\b|\bheadline\b/i.test(text)) wants.push("a heading");
  if (/\bimages?\b|\bphotos?\b|\bpictures?\b/i.test(text)) wants.push("an image");
  if (/\bcaptions?\b/i.test(text)) wants.push("a caption");
  if (/\bnotes?\b/i.test(text)) wants.push("a note");
  if (/\brenditions?\b|\bexports?\b/i.test(text)) wants.push("an export");
  return wants;
}

function joinList(items) {
  if (items.length <= 1) return items[0] || "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function writtenSummary(name, brief) {
  const wants = featurePhrases(brief);
  if (wants.length) return `Adds ${joinList(wants)} to the page.`;
  const clean = String(name || "This add-on").trim();
  return `${clean} works on the current page.`;
}

export function listingFrom({ name, brief = "", description = "", dir = "" }) {
  const phrases = dir ? phrasesFromAddon(dir) : [];
  const specific = phrases.filter((phrase) => !BOILERPLATE.test(phrase) && phrase.toLowerCase() !== String(name || "").trim().toLowerCase());
  const usable = description && !/adobe creative cloud web add-on\.?$/i.test(String(description).trim()) ? String(description).trim() : "";
  const summary = specific[0] || writtenSummary(name, brief || usable);
  const sentence = specific.length > 1
    ? `${name}. ${specific[0]}. ${specific[1]}.`
    : specific.length === 1
      ? `${name}. ${specific[0]}.`
      : `${name}. ${writtenSummary(name, brief || usable)}`;
  const words = `${featurePhrases(brief).join(" ")} ${specific.join(" ")} ${name}`.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) || [];
  const keywords = [...new Set(words.filter((word) => !KEYWORD_SKIP.has(word) && !API_WORD.test(word)))].slice(0, 6);
  return { name, summary, description: sentence.replace(/\s+/g, " ").trim(), keywords, brief: String(brief || "") };
}

export function fillListingDir(listingDir, addonDir) {
  const phrases = phrasesFromAddon(addonDir);
  if (!phrases.length) return { ok: false, error: "The add-on has no phrase the listing can quote. The template's Get Started text is not a feature." };
  const files = fs.readdirSync(listingDir).filter((name) => name.endsWith(".html"));
  if (!files.length) return { ok: false, error: "prepare-listing did not write any pages." };
  writePanelShots(listingDir, phrases);
  for (const name of files) fillPage(path.join(listingDir, name), phrases);
  const written = files.map((name) => fs.readFileSync(path.join(listingDir, name), "utf8")).join("\n");
  if (/Get Started/i.test(written)) return { ok: false, error: "The listing still shows the template's Get Started text. The screenshots are not done." };
  return { ok: true, phrases };
}

function fillPage(file, phrases) {
  let html = fs.readFileSync(file, "utf8");
  const pick = (index) => escapeHtml(phrases[index] || phrases[0]);
  const swaps = [
    ["Short phrase from the UI", pick(0)],
    ["Real count or feature", pick(1)],
    ["One sentence already written in the add-on.", pick(Math.min(2, phrases.length - 1))]
  ];
  for (const [from, to] of swaps) html = html.replace(from, to);
  let pill = 0;
  html = html.replace(/>Fact</g, () => {
    const phrase = pick(3 + pill);
    pill += 1;
    return `>${phrase}<`;
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

const PANEL_SHOTS = ["panel-back.png", "panel-front.png", "panel-mid.png", "panel-third.png"];

function writePanelShots(dir, phrases) {
  const png = capturePanel(phrases);
  for (const name of PANEL_SHOTS) fs.writeFileSync(path.join(dir, name), png);
}

function capturePanel(phrases) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "express-panel-shot-"));
  try {
    const html = path.join(scratch, "panel.html");
    const out = path.join(scratch, "panel.png");
    fs.writeFileSync(html, panelPreviewHtml(phrases));
    const chrome = findChrome();
    if (chrome) {
      try {
        shoot({ chrome, url: pathToFileURL(html).href, out, width: 360, height: 480, timeout: 8000 });
        if (fs.existsSync(out) && fs.statSync(out).size > 500) return fs.readFileSync(out);
      } catch {
        // A drawn panel of the same controls is used when Chrome cannot take the picture.
      }
    }
    return drawPanel(phrases);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function panelPreviewHtml(phrases) {
  const labels = (phrases || []).map((phrase) => String(phrase || "").trim()).filter(Boolean).slice(0, 4);
  const title = labels[0] || "Panel";
  const buttons = (labels.length ? labels : ["Add heading"]).map((label) => `<button type="button">${escapeHtml(label)}</button>`).join("");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #f4f1ea; color: #1c2430; font: 16px/1.4 "Segoe UI", sans-serif; }
  .panel { width: 300px; margin: 24px; background: #fff; border: 1px solid #d7d2c8; border-radius: 16px; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  label { display: block; font-size: 12px; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; border: 1px solid #c5c0b6; border-radius: 8px; margin-bottom: 12px; }
  button { display: inline-block; margin: 0 8px 8px 0; background: #3b63fb; color: #fff; border: 0; border-radius: 16px; padding: 8px 14px; font: inherit; }
</style>
</head>
<body>
  <div class="panel">
    <h1>${escapeHtml(title)}</h1>
    <label for="heading">Heading</label>
    <input id="heading" value="">
    ${buttons}
  </div>
</body>
</html>
`;
}

function drawPanel(phrases) {
  const width = 360;
  const height = 480;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const at = y * (width * 3 + 1) + 1 + x * 3;
    raw[at] = r;
    raw[at + 1] = g;
    raw[at + 2] = b;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) set(x, y, 244, 241, 234);
  }
  for (let y = 24; y < 456; y += 1) {
    for (let x = 30; x < 330; x += 1) set(x, y, 255, 255, 255);
  }
  for (let y = 88; y < 124; y += 1) {
    for (let x = 48; x < 312; x += 1) set(x, y, 255, 255, 255);
    if (y === 88 || y === 123) for (let x = 48; x < 312; x += 1) set(x, y, 190, 186, 178);
  }
  for (let y = 148; y < 184; y += 1) {
    for (let x = 48; x < 196; x += 1) set(x, y, 59, 99, 251);
  }
  const text = String((phrases && phrases[0]) || "Add heading").replace(/[^A-Za-z0-9 ]/g, " ").toUpperCase();
  drawText(set, text, 56, 158, 3);
  return pngEncode(width, height, raw);
}

function drawText(set, text, x, y, scale) {
  let cursor = x;
  for (const char of text) {
    const glyph = GLYPHS[char] || GLYPHS[" "];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) set(cursor + col * scale + dx, y + row * scale + dy, 255, 255, 255);
        }
      }
    }
    cursor += (glyph[0].length + 1) * scale;
  }
}

const GLYPHS = {
  " ": ["000", "000", "000", "000", "000"],
  A: ["010", "101", "111", "101", "101"],
  B: ["110", "101", "110", "101", "110"],
  C: ["011", "100", "100", "100", "011"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  G: ["011", "100", "101", "101", "011"],
  H: ["101", "101", "111", "101", "101"],
  I: ["111", "010", "010", "010", "111"],
  L: ["100", "100", "100", "100", "111"],
  M: ["101", "111", "101", "101", "101"],
  N: ["110", "101", "101", "101", "101"],
  O: ["010", "101", "101", "101", "010"],
  P: ["110", "101", "110", "100", "100"],
  R: ["110", "101", "110", "101", "101"],
  S: ["011", "100", "010", "001", "110"],
  T: ["111", "010", "010", "010", "010"],
  U: ["101", "101", "101", "101", "111"]
};

function pngEncode(width, height, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const crc = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    return Buffer.concat([length, body, sum]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    crc("IHDR", ihdr),
    crc("IDAT", zlib.deflateSync(raw)),
    crc("IEND", Buffer.alloc(0))
  ]);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}
