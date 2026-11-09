/**
 * Fill the locked listing pages with phrases that already exist in the add-on,
 * and drop image tags whose files are not there. The stylesheet and the layout stay locked.
 */
import fs from "node:fs";
import path from "node:path";
import { addonCorpus } from "../../../express-addon-review/scripts/lib/listing.mjs";

const BOILERPLATE = /^(get started|create rectangle|hello world|welcome|click me|javascript|swc-javascript|adobe creative cloud web add-on\.?)$/i;

export function phrasesFromAddon(dir) {
  const corpus = addonCorpus(dir);
  const htmlPhrases = [];
  const metaPhrases = [];
  const consider = (bucket, raw) => {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 80) return;
    if (/[{}<>]/.test(text)) return;
    if (BOILERPLATE.test(text) || /adobe creative cloud web add-on/i.test(text) || /^get started$/i.test(text)) return;
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

export function listingFrom({ name, brief = "", description = "", dir = "" }) {
  const phrases = dir ? phrasesFromAddon(dir) : [];
  const specific = phrases.filter((phrase) => !BOILERPLATE.test(phrase) && phrase.toLowerCase() !== String(name || "").trim().toLowerCase());
  const usable = description && !/adobe creative cloud web add-on\.?$/i.test(String(description).trim()) ? String(description).trim() : "";
  const lead = specific[0] || usable || String(name || "").trim();
  const summary = lead;
  const sentence = specific.length > 1 ? `${name}. ${specific[0]}. ${specific[1]}.` : `${name}. ${lead}.`;
  const skip = new Set(["the", "and", "for", "with", "add", "from", "that", "this", "into", "your", "both", "only", "via", "not", "now", "was", "are"]);
  const words = `${specific.join(" ")} ${name}`.toLowerCase().match(/\b[a-z][a-z0-9-]{2,}\b/g) || [];
  const keywords = [...new Set(words.filter((word) => !skip.has(word)))].slice(0, 6);
  return { name, summary, description: sentence.replace(/\s+/g, " ").trim(), keywords, brief: String(brief || "") };
}

export function fillListingDir(listingDir, addonDir) {
  const phrases = phrasesFromAddon(addonDir);
  if (!phrases.length) return { ok: false, error: "The add-on has no phrase the listing can quote. The template's Get Started text is not a feature." };
  const files = fs.readdirSync(listingDir).filter((name) => name.endsWith(".html"));
  if (!files.length) return { ok: false, error: "prepare-listing did not write any pages." };
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}
