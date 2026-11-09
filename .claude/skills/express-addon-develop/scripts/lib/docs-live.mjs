import fs from "node:fs";
import path from "node:path";
import { liveDir } from "./paths.mjs";

/** Pages the development flow reads. Paths are the ones Preflight already mirrors from AdobeDocs. */
export const DEV_PAGES = [
  "src/pages/guides/learn/platform-concepts/architecture.md",
  "src/pages/guides/learn/platform-concepts/document-api.md",
  "src/pages/guides/learn/platform-concepts/context.md",
  "src/pages/guides/build/design/implementation-guide.md",
  "src/pages/guides/getting-started/local-development/dev-tooling.md",
  "src/pages/guides/getting-started/addon-project-anatomy.md"
];

const RAW = "https://raw.githubusercontent.com/AdobeDocs/express-add-ons-docs/main";

/**
 * Fetch the development pages in parallel.
 * Each page is fresh, stale (a cached copy was kept), or failed.
 * `budgetMs` aborts every request. `pageMs` aborts one request.
 */
export async function fetchDevDocs({
  budgetMs = 20000,
  pageMs = 8000,
  cacheDir = liveDir,
  destDir,
  fetchImpl = globalThis.fetch,
  pages = DEV_PAGES
} = {}) {
  const started = Date.now();
  const budget = new AbortController();
  let budgetTimer;
  const budgetDone = new Promise((resolve) => {
    budgetTimer = setTimeout(() => {
      budget.abort();
      resolve("budget");
    }, budgetMs);
  });
  const work = Promise.all(pages.map((id) => one(id, { pageMs, budget, cacheDir, destDir, fetchImpl })));
  await Promise.race([work, budgetDone]);
  clearTimeout(budgetTimer);
  const results = await work;
  const counts = {
    fresh: results.filter((page) => page.label === "fresh").length,
    stale: results.filter((page) => page.label === "stale").length,
    failed: results.filter((page) => page.label === "failed").length
  };
  return {
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    budgetMs,
    pageMs,
    sha: "",
    counts,
    pages: results.map(({ text, ...page }) => page)
  };
}

async function one(id, { pageMs, budget, cacheDir, destDir, fetchImpl }) {
  const url = `${RAW}/${id}`;
  const cached = readCache(cacheDir, id);
  try {
    const response = await fetchWithTimeout(fetchImpl, url, Math.min(pageMs, 8000), budget.signal);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!text.trim()) throw new Error("Empty body");
    writeBoth(cacheDir, destDir, id, text);
    return { id, url, label: "fresh", text };
  } catch (error) {
    const reason = budget.signal.aborted ? "overall budget" : error.message;
    if (cached) {
      if (destDir) writeFile(path.join(destDir, id), cached);
      return { id, url, label: "stale", error: reason, text: cached };
    }
    return { id, url, label: "failed", error: reason, text: "" };
  }
}

function fetchWithTimeout(fetchImpl, url, ms, parent) {
  const ctrl = new AbortController();
  let timer;
  let settled = false;
  let rejectCancelled = () => {};
  const onParent = () => {
    ctrl.abort();
    if (!settled) rejectCancelled(new Error("overall budget"));
  };
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener("abort", onParent);
  }
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error("timeout"));
    }, ms);
  });
  const cancelled = new Promise((_, reject) => {
    rejectCancelled = reject;
    if (parent?.aborted) reject(new Error("overall budget"));
  });
  const request = Promise.resolve().then(() => fetchImpl(url, {
    signal: ctrl.signal,
    headers: { "user-agent": "express-addon-develop", accept: "text/plain" }
  }));
  // Race even when fetch ignores the abort signal, and always clear the timer so the process can exit.
  return Promise.race([request, timeout, cancelled]).finally(() => {
    settled = true;
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  });
}

function readCache(cacheDir, id) {
  try {
    return fs.readFileSync(path.join(cacheDir, id), "utf8");
  } catch {
    return "";
  }
}

function writeBoth(cacheDir, destDir, id, text) {
  if (cacheDir && process.env.EXPRESS_DEVELOP_KEEP_CACHE !== "1") writeFile(path.join(cacheDir, id), text);
  if (destDir) writeFile(path.join(destDir, id), text);
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function readPage(out, id, cacheDir = liveDir) {
  for (const root of [path.join(out, "docs"), cacheDir]) {
    try {
      return fs.readFileSync(path.join(root, id), "utf8");
    } catch {
      // The other copy may exist.
    }
  }
  return "";
}
