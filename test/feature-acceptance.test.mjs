import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";

function addon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feature-accept-"));
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

const manifest = (extra = {}) => `${JSON.stringify({
  name: "Sample",
  version: "1.0.0",
  manifestVersion: 2,
  requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
  entryPoints: [{ type: "panel", id: "panel1", main: "index.html", documentSandbox: "code.js" }],
  ...extra
}, null, 2)}\n`;

test("styled text is accepted only when createText sets a style", () => {
  const brief = "Add styled text to the document";
  const real = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><h1>Styled text</h1></body></html>\n",
    "code.js": "const node = editor.createText(title);\nnode.fontSize = 32;\nnode.fill = color;\n"
  });
  const ok = verifyFeature({ dir: real, brief });
  assert.equal(ok.ok, true, ok.problems.join(" "));
  assert.deepEqual(ok.needs, ["text"]);

  const stub = addon({
    "manifest.json": manifest(),
    "code.js": "export function featureReady(){ return true; }\n"
  });
  const rejected = verifyFeature({ dir: stub, brief });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /stub|createText/);
});

test("an image is accepted only when the code inserts one", () => {
  const brief = "Insert an image into the document";
  const real = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button id=\"insert\">Insert image</button></body></html>\n",
    "index.js": "await addOnUISdk.app.document.addImage(blob, { title: \"image\" });\n"
  });
  const ok = verifyFeature({ dir: real, brief });
  assert.equal(ok.ok, true, ok.problems.join(" "));
  assert.ok(ok.needs.includes("image"));

  const stub = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Create Rectangle</button></body></html>\n",
    "code.js": "export function featureReady(){ return true; }\n"
  });
  const rejected = verifyFeature({ dir: stub, brief });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /stub|addImage|createImage/);
});

test("a Spectrum panel form is accepted only with a Spectrum control", () => {
  const brief = "Add a Spectrum panel with a form";
  const real = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><sp-theme scale=\"medium\"><sp-textfield label=\"Note\"></sp-textfield><sp-button>Save</sp-button></sp-theme></body></html>\n"
  });
  const ok = verifyFeature({ dir: real, brief });
  assert.equal(ok.ok, true, ok.problems.join(" "));
  assert.ok(ok.needs.includes("panel"));

  const stub = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><label>Note</label><input id=\"develop-feature\"></body></html>\n",
    "spectrum-note.txt": "Design answer: Spectrum Web Components.\n"
  });
  const rejected = verifyFeature({ dir: stub, brief });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /stub|Spectrum/);
});

test("a network or OAuth feature is accepted only with manifest permissions", () => {
  const brief = "Sign in with OAuth and store the token";
  const real = addon({
    "manifest.json": manifest({ permissions: { oauth: ["www.dropbox.com"] } }),
    "index.html": "<!doctype html><html><body><button id=\"connect\">Connect Dropbox</button></body></html>\n",
    "index.js": "const token = await addOnUISdk.app.oauth.authorize();\n"
  });
  const ok = verifyFeature({ dir: real, brief });
  assert.equal(ok.ok, true, ok.problems.join(" "));
  assert.ok(ok.needs.includes("oauth"));

  const stub = addon({
    "manifest.json": manifest(),
    "index.js": "export function featureReady(){ return true; }\n"
  });
  const rejected = verifyFeature({ dir: stub, brief });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /stub|oauth/);
});
