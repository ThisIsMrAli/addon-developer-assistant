/**
 * Template names are parsed from whatever Adobe published at fetch time.
 * This file has no list of template ids.
 */

const REGISTRY = "https://registry.npmjs.org/@adobe/create-ccweb-add-on/latest";
const CONSTANTS = "https://raw.githubusercontent.com/adobe/create-ccweb-add-on/main/packages/create-ccweb-add-on/src/constants.ts";
const TEMPLATES_DIR = "https://api.github.com/repos/adobe/create-ccweb-add-on/contents/packages/create-ccweb-add-on/templates?ref=main";

export function parseTemplateIds(source) {
  const text = String(source || "");
  const suffix = text.match(/WITH_DOCUMENT_SANDBOX\s*=\s*["']([^"']+)["']/)?.[1] || "";
  const block = text.match(/AVAILABLE_ADD_ON_TEMPLATES[\s\S]*?=\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  const body = block[1].replaceAll("${WITH_DOCUMENT_SANDBOX}", suffix);
  const ids = [];
  for (const match of body.matchAll(/["'`]([^"'`$]+)["'`]/g)) {
    const id = match[1].trim();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) ids.push(id);
  }
  return [...new Set(ids)];
}

export function parseDocTemplateIds(markdown) {
  const ids = [];
  for (const match of String(markdown || "").matchAll(/`([a-z][a-z0-9-]{2,})`/g)) ids.push(match[1]);
  return [...new Set(ids)];
}

export async function fetchTemplates({ fetchImpl = globalThis.fetch, pageText = "" } = {}) {
  const headers = { "user-agent": "express-addon-develop", accept: "application/json, text/plain" };
  const [registry, constants, listing] = await Promise.all([
    grab(fetchImpl, REGISTRY, headers),
    grab(fetchImpl, CONSTANTS, { ...headers, accept: "text/plain" }),
    grab(fetchImpl, TEMPLATES_DIR, headers)
  ]);

  let npmVersion = "";
  if (registry.ok) {
    try {
      npmVersion = JSON.parse(registry.text).version || "";
    } catch {
      npmVersion = "";
    }
  }

  const fromConstants = constants.ok ? parseTemplateIds(constants.text) : [];
  let fromDirectory = [];
  if (listing.ok) {
    try {
      const rows = JSON.parse(listing.text);
      if (Array.isArray(rows)) {
        fromDirectory = rows.filter((row) => row.type === "dir" && /^[a-z0-9-]+$/.test(row.name || "")).map((row) => row.name);
      }
    } catch {
      fromDirectory = [];
    }
  }
  const fromDocs = parseDocTemplateIds(pageText);

  let ids = [];
  let source = "failed";
  let note = "";
  if (fromConstants.length && fromDirectory.length) {
    const directory = new Set(fromDirectory);
    const both = fromConstants.filter((id) => directory.has(id));
    if (both.length) {
      ids = both;
      source = "constants+directory";
    } else {
      ids = fromConstants;
      source = "constants";
      note = "The templates directory and constants.ts did not overlap. The constants file is the list the CLI reads.";
    }
  } else if (fromConstants.length) {
    ids = fromConstants;
    source = "constants";
  } else if (fromDirectory.length) {
    ids = fromDirectory;
    source = "directory";
  } else {
    note = "The CLI package could not be read. No template names were invented.";
  }

  const docOnly = fromDocs.filter((id) => !ids.includes(id));
  return {
    ok: ids.length > 0,
    ids,
    directory: fromDirectory,
    source,
    note,
    npmVersion,
    docOnly: docOnly.slice(0, 30),
    fetchedAt: new Date().toISOString(),
    errors: [registry, constants, listing].filter((item) => !item.ok).map((item) => `${item.url} ${item.error}`),
    raw: { constants: constants.ok ? constants.text : "" }
  };
}

async function grab(fetchImpl, url, headers) {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!response.ok) return { ok: false, url, error: `HTTP ${response.status}`, text: "" };
    return { ok: true, url, error: "", text: await response.text() };
  } catch (error) {
    return { ok: false, url, error: error.message, text: "" };
  }
}
