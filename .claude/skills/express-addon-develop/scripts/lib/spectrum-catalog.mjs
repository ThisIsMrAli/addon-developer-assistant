import fs from "node:fs";
import path from "node:path";

/**
 * The Spectrum component set is whatever `@spectrum-web-components/bundle` publishes.
 * A short list in this skill is not that set. `docs` fetches the bundle and each package's `sp-*` exports.
 */

const BUNDLE = "@spectrum-web-components/bundle";
const REGISTRY = "https://registry.npmjs.org";
const DOCS = "https://opensource.adobe.com/spectrum-web-components";
const TOOL_PAGES = new Set(["theme", "styles", "base", "grid", "truncated", "reactive-controllers", "shared"]);

export function docsUrl(slug) {
  const section = TOOL_PAGES.has(slug) ? "tools" : "components";
  return `${DOCS}/${section}/${slug}/`;
}

export function tagsFromExports(exportsField) {
  const tags = [];
  for (const key of Object.keys(exportsField || {})) {
    const match = String(key).match(/^\.\/(sp-[a-z0-9-]+)\.js$/);
    if (match) tags.push(match[1]);
  }
  return tags;
}

export function packageName(spec) {
  return String(spec || "").replace(/^@spectrum-web-components\//, "");
}

/**
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ ok: boolean, version: string, components: Array<{ tag: string, package: string, import: string, docs: string }>, failed: string[], error?: string }>}
 */
export async function fetchSpectrumCatalog({ fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  let bundle;
  try {
    bundle = await readJson(fetchImpl, `${REGISTRY}/${BUNDLE}/latest`, timeoutMs);
  } catch (error) {
    return { ok: false, version: "", components: [], failed: [], error: error.message || "The Spectrum bundle could not be fetched." };
  }
  const version = String(bundle.version || "");
  const names = Object.keys(bundle.dependencies || {}).filter((name) => name.startsWith("@spectrum-web-components/") && name !== BUNDLE);
  const failed = [];
  const components = [];
  const queue = [...names];
  async function one(name) {
    try {
      const pkg = await readJson(fetchImpl, `${REGISTRY}/${name}/latest`, timeoutMs);
      const slug = packageName(name);
      for (const tag of tagsFromExports(pkg.exports)) {
        components.push({
          tag,
          package: name,
          import: `${name}/${tag}.js`,
          docs: docsUrl(slug)
        });
      }
    } catch (error) {
      failed.push(`${name}: ${error.message || "failed"}`);
    }
  }
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  });
  await Promise.all(workers);
  components.sort((a, b) => a.tag.localeCompare(b.tag));
  return {
    ok: components.length > 0,
    version,
    components,
    failed,
    error: components.length ? "" : "The Spectrum bundle returned no sp-* components."
  };
}

export function writeSpectrumCatalog(dir, catalog) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "catalog.json");
  fs.writeFileSync(file, `${JSON.stringify({ version: catalog.version, fetchedAt: new Date().toISOString(), components: catalog.components, failed: catalog.failed }, null, 2)}\n`);
  const lines = [
    `# Spectrum Web Components`,
    ``,
    `Fetched from \`@spectrum-web-components/bundle@${catalog.version || "unknown"}\`. ${catalog.components.length} components.`,
    `This is the set. A shorter list in the skill is only a set of examples.`,
    ``,
    `| Tag | Import | Docs |`,
    `| --- | --- | --- |`,
    ...catalog.components.map((item) => `| \`${item.tag}\` | \`${item.import}\` | ${item.docs} |`),
    ``
  ];
  if (catalog.failed?.length) lines.push(`## Not fetched`, ``, ...catalog.failed.map((item) => `- ${item}`), ``);
  const markdown = path.join(dir, "catalog.md");
  fs.writeFileSync(markdown, lines.join("\n"));
  return { file, markdown };
}

export function readSpectrumCatalog(file) {
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    const components = Array.isArray(body.components) ? body.components : [];
    return { version: body.version || "", components, tags: new Set(components.map((item) => item.tag)) };
  } catch {
    return null;
  }
}

async function readJson(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
