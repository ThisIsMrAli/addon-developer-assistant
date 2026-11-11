import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSource, sandboxEngineProblems } from "./code-scan.mjs";

const SDK_URL = "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

/** A 1×1 PNG. Blob(["png"]) is not a PNG, and the audit then reports image-broken. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function pngBytes() {
  return Buffer.from(PNG_BASE64, "base64");
}

/**
 * Methods the sandbox passes to runtime.exposeApi.
 * The object can be written inline, through an alias (or an alias of an alias), with spread,
 * with properties assigned one by one, or with Object.assign. Wrapper methods count by their keys.
 * A panel `_sandboxProxy.method()` call is not an exposed method. The stand-in answers only what the sandbox exposes.
 */
export function exposedSandboxMethods(source) {
  const text = String(source || "");
  const found = new Set();
  const parsed = parseSource("sandbox.js", text);
  if (!parsed.ast) return [];
  const inits = new Map();
  const assigned = new Map();
  const classes = new Map();
  const protoMethods = new Map();
  const exposedArgs = [];
  visit(parsed.ast, (node) => {
    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id?.name) classes.set(node.id.name, node);
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
      const list = inits.get(node.id.name) || [];
      list.push(node.init);
      inits.set(node.id.name, list);
    }
    if (node.type === "AssignmentExpression" && node.operator === "=") {
      if (node.left?.type === "Identifier") {
        const list = inits.get(node.left.name) || [];
        list.push(node.right);
        inits.set(node.left.name, list);
      }
      if (node.left?.type === "MemberExpression" && node.left.object?.type === "Identifier") {
        const key = node.left.computed ? (node.left.property?.type === "StringLiteral" ? node.left.property.value : "") : node.left.property?.name;
        if (key) {
          const list = assigned.get(node.left.object.name) || [];
          list.push(key);
          assigned.set(node.left.object.name, list);
        }
      }
      if (node.left?.type === "MemberExpression" && node.left.object?.type === "MemberExpression" && !node.left.object.computed && node.left.object.property?.name === "prototype" && node.left.object.object?.type === "Identifier") {
        const key = node.left.computed ? (node.left.property?.type === "StringLiteral" ? node.left.property.value : "") : node.left.property?.name;
        if (key) {
          const list = protoMethods.get(node.left.object.object.name) || [];
          list.push(key);
          protoMethods.set(node.left.object.object.name, list);
        }
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const name = callee?.type === "Identifier" ? callee.name : callee?.property?.name;
      if (name === "exposeApi" && node.arguments?.[0]) exposedArgs.push(node.arguments[0]);
    }
  });
  const seen = new Set();
  const addObject = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.type === "AwaitExpression" || node.type === "TSAsExpression" || node.type === "ParenthesizedExpression") return addObject(node.argument || node.expression);
    if (node.type === "Identifier") {
      for (const init of inits.get(node.name) || []) addObject(init);
      for (const key of assigned.get(node.name) || []) add(key);
      return;
    }
    if (node.type === "ObjectExpression") {
      for (const prop of node.properties || []) {
        if (prop.type === "SpreadElement") { addObject(prop.argument); continue; }
        if (prop.computed && prop.key?.type !== "StringLiteral") continue;
        add(prop.key?.name || prop.key?.value);
      }
      return;
    }
    if (node.type === "NewExpression") {
      const ctor = node.callee?.type === "ParenthesizedExpression" ? node.callee.expression : node.callee;
      if (ctor?.type === "ClassExpression") addClassBody(ctor);
      if (ctor?.type === "Identifier") {
        if (classes.has(ctor.name)) addClassBody(classes.get(ctor.name));
        for (const key of protoMethods.get(ctor.name) || []) add(key);
      }
      return;
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const isAssign = callee?.type === "MemberExpression" && callee.object?.name === "Object" && callee.property?.name === "assign";
      if (isAssign) for (const arg of node.arguments || []) addObject(arg);
      return;
    }
    if (node.type === "ConditionalExpression") { addObject(node.consequent); addObject(node.alternate); }
    if (node.type === "LogicalExpression") { addObject(node.left); addObject(node.right); }
  };
  function add(key) {
    if (typeof key === "string" && /^[A-Za-z_$]/.test(key)) found.add(key);
  }
  function addClassBody(cls) {
    for (const item of cls.body?.body || []) {
      if (item.static || item.kind === "constructor") continue;
      if ((item.type === "ClassMethod" || item.type === "ClassProperty" || item.type === "ClassPrivateMethod") && !item.computed && (item.key?.type === "Identifier" || item.key?.type === "StringLiteral")) add(item.key.name || item.key.value);
    }
  }
  for (const arg of exposedArgs) addObject(arg);
  return [...found];
}

function visit(node, fn) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || /Comments$/.test(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => visit(item, fn));
    else if (value && typeof value === "object" && typeof value.type === "string") visit(value, fn);
  }
}

function chainOf(node) {
  const parts = [];
  let current = node;
  while (current) {
    if (current.type === "Identifier") { parts.unshift(current.name); return parts; }
    if (current.type === "ThisExpression") { parts.unshift("this"); return parts; }
    if (current.type === "MemberExpression" && !current.computed && current.property?.type === "Identifier") {
      parts.unshift(current.property.name);
      current = current.object;
      continue;
    }
    return null;
  }
  return null;
}

function callsApiProxy(node) {
  let hit = false;
  visit(node, (inner) => {
    if (inner.type === "CallExpression" && (inner.callee?.property?.name === "apiProxy" || inner.callee?.name === "apiProxy")) hit = true;
  });
  return hit;
}

/**
 * Panel calls through the sandbox proxy, found by where the receiver came from: whatever was
 * assigned the result of runtime.apiProxy(), and its aliases and destructured methods.
 * Names such as `proxy` or `sandboxProxy` still count when the assignment is out of sight.
 * These are not addOnUISdk.app.document methods.
 */
export function panelSandboxCalls(source) {
  const found = [];
  const parsed = parseSource("panel.js", String(source || ""));
  if (!parsed.ast) return found;
  const proxies = new Set();
  const methods = new Map();
  const bindings = [];
  visit(parsed.ast, (node) => {
    let target = null;
    let init = null;
    if (node.type === "VariableDeclarator") { target = node.id; init = node.init; }
    if (node.type === "AssignmentExpression" && node.operator === "=") { target = node.left; init = node.right; }
    if (target && init) bindings.push({ target, init });
    if (node.type === "CallExpression" && node.callee?.property?.name === "then" && callsApiProxy(node.callee.object)) {
      const fn = node.arguments?.[0];
      const param = fn?.params?.[0];
      if (param?.type === "Identifier") proxies.add(param.name);
    }
  });
  const isProxy = (node) => {
    if (!node) return false;
    if (node.type === "AwaitExpression") return isProxy(node.argument);
    if (node.type === "CallExpression" && (node.callee?.property?.name === "apiProxy" || node.callee?.name === "apiProxy")) return true;
    const chain = chainOf(node);
    if (!chain) return false;
    const key = chain.join(".");
    return proxies.has(key) || chain.some((part) => part === "proxy" || /sandboxproxy/i.test(part));
  };
  for (let round = 0; round < 6; round += 1) {
    let grew = false;
    for (const { target, init } of bindings) {
      if (!isProxy(init)) continue;
      if (target.type === "ObjectPattern") {
        for (const prop of target.properties || []) {
          if (prop.type !== "ObjectProperty" || prop.computed) continue;
          const key = prop.key?.name || prop.key?.value;
          const local = prop.value?.type === "Identifier" ? prop.value.name : prop.value?.left?.name;
          if (key && local && !methods.has(local)) { methods.set(local, key); grew = true; }
        }
        continue;
      }
      const chain = chainOf(target);
      const key = chain ? chain.join(".") : "";
      if (key && !proxies.has(key)) { proxies.add(key); grew = true; }
    }
    if (!grew) break;
  }
  visit(parsed.ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee?.type === "MemberExpression" && !callee.computed && callee.property?.type === "Identifier") {
      const prop = callee.property.name;
      if ((prop === "call" || prop === "apply" || prop === "bind") && callee.object?.type === "MemberExpression" && !callee.object.computed && callee.object.property?.type === "Identifier" && isProxy(callee.object.object)) found.push(callee.object.property.name);
      else if ((prop === "call" || prop === "apply" || prop === "bind") && callee.object?.type === "Identifier" && methods.has(callee.object.name)) found.push(methods.get(callee.object.name));
      else if (isProxy(callee.object)) found.push(prop);
    }
    if (callee?.type === "Identifier" && methods.has(callee.name)) found.push(methods.get(callee.name));
  });
  return found;
}

/** Panel proxy calls whose names are not in runtime.exposeApi. */
export function sandboxApiMismatches(files, { exposed: known = null } = {}) {
  const exposed = new Set(known || []);
  const called = [];
  for (const file of files || []) {
    const text = String(file.text || "");
    if (!/\.(mjs|cjs|jsx?|tsx?)$/i.test(file.rel || file.file || "code.js")) continue;
    if (!known) for (const name of exposedSandboxMethods(text)) exposed.add(name);
    called.push(...panelSandboxCalls(text));
  }
  return [...new Set(called.filter((name) => !exposed.has(name)))];
}

/**
 * The panel SDK stand-in. When the add-on's built sandbox file is served next to it, apiProxy
 * loads that file against the document stand-in and returns the methods it really exposed, so a
 * panel press runs the add-on's own sandbox code and shows what it really returns or throws.
 * Without a sandbox file, each exposed name answers "" (a sandbox that returns nothing), never an object.
 */
export function standInSource(methods = [], { sandbox = "", engine = [] } = {}) {
  const names = [...new Set(methods.filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)))];
  const fallback = names.length ? names : ["createRectangle"];
  const body = `async () => {
        const sandboxUrl = ${JSON.stringify(sandbox)};
        const engineProblems = ${JSON.stringify(engine)};
        if (sandboxUrl) {
          try {
            await import(sandboxUrl);
            const doc = globalThis.__expressDocumentStandIn;
            const api = doc && doc.log.exposed;
            if (api && typeof api === "object") {
              const proxy = {};
              const names = [];
              for (let obj = api; obj && obj !== Object.prototype; obj = Object.getPrototypeOf(obj)) {
                for (const name of Object.getOwnPropertyNames(obj)) {
                  if (name === "constructor" || names.indexOf(name) !== -1) continue;
                  if (typeof obj[name] === "function") names.push(name);
                }
              }
              for (const name of names) {
                proxy[name] = async (...args) => {
                  const seen = doc.log.violations.length;
                  // Express's document sandbox lacks these built-ins, so this code can throw "not a function" there (NP11).
                  for (const note of engineProblems) console.error("express-sdk-stand-in: the sandbox " + name + "() would fail in Express: " + note);
                  try {
                    return await api[name](...args);
                  } catch (error) {
                    console.error("express-sdk-stand-in: sandbox " + name + "() threw: " + (error && error.message ? error.message : error));
                    throw error;
                  } finally {
                    for (const note of doc.log.violations.slice(seen)) console.error("express-sdk-stand-in: sandbox " + name + "(): " + note);
                  }
                };
              }
              return proxy;
            }
            console.error("express-sdk-stand-in: the sandbox file loaded but did not call runtime.exposeApi with an object.");
            return {};
          } catch (error) {
            console.error("express-sdk-stand-in: the sandbox file did not load: " + (error && error.message ? error.message : error));
          }
        }
        return {
${fallback.map((name) => `          ${name}: async () => ""`).join(",\n")}
        };
      }`;
  const start = STANDIN_SOURCE.indexOf("apiProxy: async () => ({");
  const end = STANDIN_SOURCE.indexOf("      }),", start);
  return `${STANDIN_SOURCE.slice(0, start)}apiProxy: ${body},${STANDIN_SOURCE.slice(end + "      }),".length)}`;
}

/** The document sandbox SDK modules for the browser, both bare names point here through an import map. */
export const SANDBOX_SDK_STANDIN = `import { createDocument } from "./document-stand-in.mjs";
const doc = createDocument({ width: 1920, height: 1080 });
globalThis.__expressDocumentStandIn = doc;
export const editor = doc.editor;
export const constants = doc.constants;
export const colorUtils = doc.colorUtils;
export const fonts = doc.fonts;
export default doc.modules["add-on-sdk-document-sandbox"].default;
`;

export const STANDIN_SOURCE = `/**
 * SDK STAND-IN
 * label: express-sdk-stand-in
 * This module is not Adobe Express. A browser run is not an Express pass.
 */
console.info("express-sdk-stand-in: not Adobe Express. A browser run is not an Express pass.");
document.documentElement.dataset.expressSdkStandIn = "express-sdk-stand-in";
if (typeof ShadowRoot !== "undefined" && !ShadowRoot.prototype.getElementById) {
  ShadowRoot.prototype.getElementById = function (id) {
    if (!id) return null;
    return this.querySelector("#" + CSS.escape(String(id)));
  };
}
export const AppEvent = {
  themechange: "themechange",
  localechange: "localechange",
  formatchange: "formatchange",
  reset: "reset",
  dragstart: "dragstart",
  dragend: "dragend",
  dragcancel: "dragcancel",
  accessTokenChange: "accessTokenChange",
  documentIdAvailable: "documentIdAvailable",
  documentLinkAvailable: "documentLinkAvailable",
  documentPublishedLinkAvailable: "documentPublishedLinkAvailable",
  documentTitleChange: "documentTitleChange",
  documentExportAllowedChange: "documentExportAllowedChange",
  internalMessage: "internalMessage",
  updateReviewSettings: "updateReviewSettings"
};
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
  const sandbox = sandboxFileIn(root);
  if (sandbox) {
    fs.copyFileSync(DOCUMENT_STANDIN, path.join(root, "document-stand-in.mjs"));
    fs.writeFileSync(path.join(root, "sandbox-sdk-stand-in.js"), SANDBOX_SDK_STANDIN);
    addImportMap(root);
  }
  const engine = sandbox ? sandboxEngineProblems([{ rel: sandbox, text: fs.readFileSync(path.join(root, sandbox), "utf8") }]) : [];
  fs.writeFileSync(path.join(root, "sdk-stand-in.js"), standInSource(methods, { sandbox: sandbox ? `./${sandbox}` : "", engine }));
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

const DOCUMENT_STANDIN = fileURLToPath(new URL("./document-stand-in.mjs", import.meta.url));
const SANDBOX_MODULES = ["add-on-sdk-document-sandbox", "express-document-sdk"];

/** The manifest's documentSandbox file in the served folder, when it is an ES module that imports the sandbox SDK. */
export function sandboxFileIn(root) {
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  } catch {
    return "";
  }
  for (const point of manifest.entryPoints || []) {
    const rel = String(point.documentSandbox || "").replace(/^\.?\/+/, "");
    if (!rel || rel.includes("..")) continue;
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (SANDBOX_MODULES.some((name) => text.includes(`"${name}"`) || text.includes(`'${name}'`))) return rel.split(path.sep).join("/");
  }
  return "";
}

function addImportMap(root) {
  const map = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(SANDBOX_MODULES.map((name) => [name, "./sandbox-sdk-stand-in.js"])) })}</script>`;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
    const file = path.join(root, entry.name);
    const html = fs.readFileSync(file, "utf8");
    if (html.includes('type="importmap"')) continue;
    const next = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (tag) => `${tag}\n${map}`) : `${map}\n${html}`;
    fs.writeFileSync(file, next);
  }
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
