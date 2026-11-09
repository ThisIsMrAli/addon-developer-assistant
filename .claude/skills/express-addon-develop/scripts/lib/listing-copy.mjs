/**
 * Fill the locked listing pages with phrases that already exist in the add-on,
 * and drop image tags whose files are not there. The stylesheet and the layout stay locked.
 */
import fs from "node:fs";
import path from "node:path";
import { addonCorpus } from "../../../express-addon-review/scripts/lib/listing.mjs";

export function phrasesFromAddon(dir) {
  const corpus = addonCorpus(dir);
  const found = [];
  const consider = (raw) => {
    const text = String(raw || "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 80) return;
    if (/[{}<>]/.test(text)) return;
    if (/adobe creative cloud web add-on/i.test(text)) return;
    if (!corpus.includes(text.toLowerCase())) return;
    if (found.some((item) => item.toLowerCase() === text.toLowerCase())) return;
    found.push(text);
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
        const page = fs.readFileSync(full, "utf8").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
        for (const piece of page.replace(/<[^>]+>/g, "\n").split("\n")) consider(piece);
      } else if (/\.json$/i.test(entry.name) && !/lock\.json$/i.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        for (const match of source.matchAll(/"(?:name|summary|description)"\s*:\s*"([^"]+)"/g)) consider(match[1]);
      }
    }
  };
  walk(dir);
  return found;
}

export function fillListingDir(listingDir, addonDir) {
  const phrases = phrasesFromAddon(addonDir);
  if (!phrases.length) return { ok: false, error: "The add-on has no phrase the listing can quote." };
  const files = fs.readdirSync(listingDir).filter((name) => name.endsWith(".html"));
  if (!files.length) return { ok: false, error: "prepare-listing did not write any pages." };
  for (const name of files) fillPage(path.join(listingDir, name), phrases);
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
