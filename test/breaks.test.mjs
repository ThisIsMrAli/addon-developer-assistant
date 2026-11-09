import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { buildProject, buildReportedError } from "../.claude/skills/express-addon-develop/scripts/lib/package-addon.mjs";

function addon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "break-"));
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

function manifest(point = {}) {
  return `${JSON.stringify({
    name: "Sample",
    version: "1.0.0",
    manifestVersion: 2,
    requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
    entryPoints: [{ type: "panel", id: "panel1", main: "index.html", documentSandbox: "code.js", ...point }]
  }, null, 2)}\n`;
}

function reject(dir, brief, pattern) {
  const result = verifyFeature({ dir, brief, build: false });
  assert.equal(result.ok, false, result.problems.join(" "));
  assert.match(result.problems.join(" "), pattern);
}

const heading = "Add a styled heading and an image to the document";
const form = "A panel with a Spectrum text field and button that inserts the typed text into the document via the document sandbox";
const oauth = "Connect Dropbox with OAuth and clientStorage";
const rendition = "Export the current page as a PNG rendition and download it";

const goodHeading = {
  "manifest.json": manifest(),
  "index.html": "<!doctype html><html><body><button id=\"add\">Add heading</button></body></html>\n",
  "index.js": "await addOnUISdk.app.document.addImage(blob, { title: \"photo\" });\n",
  "code.js": "const node = editor.createText(title);\nnode.fontSize = 32;\nnode.fill = color;\n"
};

test("a v1 a featureReady stub is rejected", () => {
  reject(addon({ "manifest.json": manifest(), "code.js": "export function featureReady(){ return true; }\n", "index.html": "<!doctype html><html><body></body></html>\n" }), heading, /stub|featureReady/);
});

test("a v2 APIs that appear only in comments are rejected", () => {
  reject(addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Draw</button></body></html>\n",
    "code.js": "// editor.createText('Hi')\n/* addImage() */\neditor.createRectangle();\n"
  }), heading, /createText|addImage/);
});

test("a v3 createText in the iframe is rejected", () => {
  reject(addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add</button></body></html>\n",
    "index.js": "editor.createText('Hi');\n",
    "code.js": "editor.createRectangle();\n"
  }), heading, /iframe/);
});

test("a v4 an uncaught throw is rejected", () => {
  reject(addon({
    ...goodHeading,
    "index.js": `${goodHeading["index.js"]}throw new Error("boom");\n`
  }), heading, /throws/);
});

test("a v5 a blank panel is rejected", () => {
  reject(addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body></body></html>\n",
    "code.js": "const node = editor.createText('Hi');\nnode.fontSize = 20;\n",
    "index.js": "await addOnUISdk.app.document.addImage(blob, { title: 'photo' });\n"
  }), heading, /blank/);
});

test("a v6 a syntax error is rejected", () => {
  reject(addon({
    ...goodHeading,
    "code.js": `${goodHeading["code.js"]}export const x = ;\n`
  }), heading, /parse|missing its value|SyntaxError/);
});

test("b v1 a form that inserts nothing is rejected", () => {
  reject(addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><sp-theme><sp-textfield label=\"Note\"></sp-textfield><sp-button>Insert</sp-button></sp-theme></body></html>\n"
  }), form, /createText/);
});

test("b v2 a Spectrum name that appears only in a comment is rejected", () => {
  reject(addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><!-- <sp-button>Go</sp-button> --><input></body></html>\n",
    "code.js": "const node = editor.createText('Hi');\nnode.fontSize = 18;\n"
  }), form, /Spectrum|sp-button|comment/);
});

test("c v1 OAuth without the documented permission is rejected", () => {
  reject(addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Connect</button></body></html>\n",
    "index.js": "try { await addOnUISdk.app.oauth.authorize(); await addOnUISdk.instance.clientStorage.setItem('token', token); } catch (error) {}\n"
  }), oauth, /entryPoints[\s\S]*oauth|permissions\.oauth/);
});

test("c v2 window.open is not OAuth", () => {
  reject(addon({
    "manifest.json": manifest({ permissions: { oauth: ["www.dropbox.com"] } }),
    "index.html": "<!doctype html><html><body><button>Connect</button></body></html>\n",
    "index.js": "window.open('https://www.dropbox.com/oauth2/authorize');\naddOnUISdk.instance.clientStorage.setItem('token', 'x');\n"
  }), oauth, /authorize|window\.open/);
});

test("c v3 localStorage is not clientStorage", () => {
  reject(addon({
    "manifest.json": manifest({ permissions: { oauth: ["www.dropbox.com"] } }),
    "index.html": "<!doctype html><html><body><button>Connect</button></body></html>\n",
    "index.js": "try { await addOnUISdk.app.oauth.authorize(); localStorage.setItem('token', token); } catch (error) {}\n"
  }), oauth, /clientStorage|localStorage/);
});

test("c v4 authorize without a catch is rejected", () => {
  reject(addon({
    "manifest.json": manifest({ permissions: { oauth: ["www.dropbox.com"] } }),
    "index.html": "<!doctype html><html><body><button>Connect</button></body></html>\n",
    "index.js": "const token = await addOnUISdk.app.oauth.authorize();\nawait addOnUISdk.instance.clientStorage.setItem('token', token);\n"
  }), oauth, /catch/);
});

test("d v1 a download without allow-downloads is rejected", () => {
  reject(addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Export PNG</button></body></html>\n",
    "index.js": "await addOnUISdk.app.document.createRenditions({ range: addOnUISdk.constants.Range.currentPage }, addOnUISdk.constants.RenditionIntent.export);\n"
  }), rendition, /allow-downloads/);
});

test("d v2 exportPage is not createRenditions", () => {
  reject(addon({
    "manifest.json": manifest({ permissions: { sandbox: ["allow-downloads"] } }),
    "index.html": "<!doctype html><html><body><button>Export PNG</button></body></html>\n",
    "index.js": "await exportPage();\n"
  }), rendition, /createRenditions|exportPage/);
});

test("d v3 the word export is not a rendition", () => {
  reject(addon({
    "manifest.json": manifest({ permissions: { sandbox: ["allow-downloads"] } }),
    "index.html": "<!doctype html><html><body><p>export</p></body></html>\n",
    "index.js": "const label = \"export\";\n"
  }), rendition, /createRenditions/);
});

test("a build that prints a syntax error and exits 0 is a failed build", () => {
  assert.equal(buildReportedError(0, "ERROR in ./src/sandbox/code.js\nSyntaxError: Unexpected token"), true);
  assert.equal(buildReportedError(0, "compiled"), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "break-build-"));
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "break-build", private: true, scripts: { build: "node -e \"console.error('SyntaxError: Unexpected token'); process.exit(0)\"" } }, null, 2)}\n`);
  const built = buildProject(dir);
  assert.equal(built.ok, false, built.note || built.error);
  assert.match(built.error, /SyntaxError/);
  const ran = spawnSync(process.execPath, ["-e", "console.error('SyntaxError: Unexpected token'); process.exit(0)"]);
  assert.equal(ran.status, 0);
});
