import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { parseSource } from "./code-scan.mjs";

const SDK_URL = "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

/** A 1×1 PNG. Blob(["png"]) is not a PNG, and the audit then reports image-broken. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function pngBytes() {
  return Buffer.from(PNG_BASE64, "base64");
}

/**
 * Methods the sandbox passes to runtime.exposeApi, plus the panel's `_sandboxProxy.method()` calls.
 * The stand-in has to answer the add-on's API, not only the template's createRectangle.
 */
export function exposedSandboxMethods(source) {
  const text = String(source || "");
  const found = new Set();
  const parsed = parseSource("sandbox.js", text);
  const objects = new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "ObjectExpression") {
      objects.set(node.id.name, node.init);
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name = callee?.type === "Identifier" ? callee.name : callee?.property?.name;
      if (name === "exposeApi" && node.arguments?.[0]) addObject(node.arguments[0]);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  const addObject = (node) => {
    const object = node?.type === "Identifier" ? objects.get(node.name) : node?.type === "ObjectExpression" ? node : null;
    if (!object) return;
    for (const prop of object.properties || []) {
      if (prop.type === "SpreadElement") continue;
      const key = prop.key?.name || prop.key?.value;
      if (typeof key === "string" && /^[A-Za-z_]/.test(key)) found.add(key);
    }
  };
  if (parsed.ast) visit(parsed.ast);
  for (const match of text.matchAll(/_sandboxProxy\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) found.add(match[1]);
  return [...found];
}

export function standInSource(methods = []) {
  const names = [...new Set(methods.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))];
  if (!names.length) return STANDIN_SOURCE;
  const body = names.map((name) => `        ${name}(...args) { return { ok: true, api: ${JSON.stringify(name)}, args }; }`).join(",\n");
  const start = STANDIN_SOURCE.indexOf("apiProxy: async () => ({");
  const end = STANDIN_SOURCE.indexOf("      }),", start);
  return `${STANDIN_SOURCE.slice(0, start)}apiProxy: async () => ({\n${body}\n      }),${STANDIN_SOURCE.slice(end + "      }),".length)}`;
}

export const STANDIN_SOURCE = `/**
 * SDK STAND-IN
 * label: express-sdk-stand-in
 * This module is not Adobe Express. A browser run is not an Express pass.
 */
console.info("express-sdk-stand-in: not Adobe Express. A browser run is not an Express pass.");
document.documentElement.dataset.expressSdkStandIn = "express-sdk-stand-in";
export const RuntimeType = {
  documentSandbox: "documentSandbox",
  panel: "panel",
  dialog: "dialog"
};
export const constants = {
  RuntimeType,
  Range: { currentPage: "currentPage", entireDocument: "entireDocument" },
  RenditionIntent: { preview: "preview", export: "export", print: "print" },
  RenditionFormat: { png: "png", jpg: "jpg", pdf: "pdf" }
};
const sdk = {
  ready: Promise.resolve(),
  constants,
  app: {
    ui: { theme: "light" },
    on() {},
    off() {},
    document: {
      addImage: async () => ({ title: "image" }),
      createRenditions: async () => {
        const bytes = Uint8Array.from(atob("${PNG_BASE64}"), (char) => char.charCodeAt(0));
        return [{ blob: new Blob([bytes], { type: "image/png" }) }];
      },
      exportAllowed: async () => true
    },
    oauth: {
      authorize: async () => {
        throw new Error("The OAuth window did not finish.");
      }
    }
  },
  instance: {
    runtime: {
      type: RuntimeType.panel,
      apiProxy: async () => ({
        createRectangle(...args) { return { ok: true, api: "createRectangle", args }; }
      }),
      exposeApi() {}
    },
    clientStorage: {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {}
    }
  }
};
export default sdk;
`;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

/**
 * Copy a built (or source) folder, rewrite the Adobe SDK import to the labelled stand-in, and serve it.
 * The stand-in never claims to be Express.
 */
export async function serveWithStandIn(sourceDir) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(osTmp()), "express-standin-"));
  copyTree(sourceDir, root);
  rewriteTree(root);
  const methods = [];
  const collect = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (/\.(js|mjs|cjs)$/i.test(entry.name) && fs.statSync(full).size < 2_000_000) {
        methods.push(...exposedSandboxMethods(fs.readFileSync(full, "utf8")));
      }
    }
  };
  collect(root);
  fs.writeFileSync(path.join(root, "sdk-stand-in.js"), standInSource(methods));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const entry = fs.existsSync(path.join(root, "index.html")) ? "index.html" : "";
  return {
    root,
    url: `http://127.0.0.1:${port}/${entry}`,
    label: "express-sdk-stand-in",
    expressPass: false,
    close: () => new Promise((resolve) => server.close(() => {
      fs.rmSync(root, { recursive: true, force: true });
      resolve();
    }))
  };
}

function osTmp() {
  return os.tmpdir();
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

function rewriteTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) rewriteTree(full);
    else if (/\.(html|js|mjs|cjs)$/.test(entry.name)) {
      const text = fs.readFileSync(full, "utf8");
      if (text.includes(SDK_URL)) fs.writeFileSync(full, text.split(SDK_URL).join("./sdk-stand-in.js"));
    }
  }
}

export function builtDir(project) {
  for (const name of ["dist", "build", "out"]) {
    if (fs.existsSync(path.join(project, name, "index.html"))) return path.join(project, name);
  }
  if (fs.existsSync(path.join(project, "src", "index.html"))) return path.join(project, "src");
  if (fs.existsSync(path.join(project, "index.html"))) return project;
  return "";
}
