import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const SDK_URL = "https://new.express.adobe.com/static/add-on-sdk/sdk.js";

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
      createRenditions: async () => [{ blob: new Blob(["png"], { type: "image/png" }) }],
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
        createRectangle() { return { width: 240, height: 180 }; }
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
  fs.writeFileSync(path.join(root, "sdk-stand-in.js"), STANDIN_SOURCE);
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
  return process.env.TMPDIR || "/tmp";
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
