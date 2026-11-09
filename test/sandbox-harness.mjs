/** Runs a sandbox snippet against the skill's document stand-in, the same model `record` uses. */
import os from "node:os";
import path from "node:path";
import { createDocument } from "../.claude/skills/express-addon-develop/scripts/lib/document-stand-in.mjs";
import { loadEntry } from "../.claude/skills/express-addon-develop/scripts/lib/sandbox-loader.mjs";

export async function loadSnippet(source, options = {}) {
  const doc = createDocument(options);
  const exposed = await loadEntry(path.join(os.tmpdir(), "harness-sandbox-code.js"), doc, source);
  const api = exposed || doc.log.entryExports || {};
  const nodes = () => doc.page.children.toArray().filter((node) => node.id !== "background" && node.id !== "existing");
  return { doc, api, page: doc.page, nodes, texts: () => nodes().filter((node) => node.type === "text"), images: () => nodes().filter((node) => node.type === "mediaContainer") };
}

export function boxOf(node) {
  const box = node.boundsInParent;
  return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, cx: box.x + box.width / 2, width: box.width, height: box.height };
}

export function overlaps(a, b) {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}

export function inside(box, width, height, margin = 0) {
  return box.left >= margin - 0.5 && box.top >= margin - 0.5 && box.right <= width - margin + 0.5 && box.bottom <= height - margin + 0.5;
}
