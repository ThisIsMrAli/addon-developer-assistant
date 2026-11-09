import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { implementationHandoff, TEXT_INSIDE_PAGE, verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { pagesForBrief } from "../.claude/skills/express-addon-develop/scripts/lib/docs-live.mjs";

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
    "code.js": TEXT_INSIDE_PAGE
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

test("NX13 inserted text without page bounds is rejected", () => {
  const brief = "Add styled text to the document";
  const loose = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add heading</button></body></html>\n",
    "code.js": "const node = editor.createText(title);\nnode.fontSize = 120;\nnode.fill = color;\n"
  });
  const overflow = verifyFeature({ dir: loose, brief, build: false });
  assert.equal(overflow.ok, false);
  assert.match(overflow.problems.join(" "), /positioning or bounds/);
  assert.match(overflow.problems.join(" "), /left edge/);

  const commented = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add heading</button></body></html>\n",
    "code.js": "// setPositionInParent boundsLocal centerPointLocal insertionParent width resize\nconst node = editor.createText(title);\nnode.fontSize = 120;\n"
  });
  const hidden = verifyFeature({ dir: commented, brief, build: false });
  assert.equal(hidden.ok, false);
  assert.match(hidden.problems.join(" "), /positioning or bounds/);

  const handoff = implementationHandoff({ brief });
  const textApi = handoff.apis.find((item) => item.api === "editor.createText()");
  assert.match(textApi.snippet, /setPositionInParent/);
  assert.match(textApi.snippet, /boundsLocal/);
  assert.match(textApi.snippet, /centerPointLocal/);
  assert.match(textApi.snippet, /insertionParent/);
  assert.match(textApi.snippet, /ResizeBehavior\.contain/);
  assert.match(textApi.note, /use-text\.md/);
  assert.match(textApi.note, /position-elements\.md/);
  assert.match(textApi.note, /resize-elements\.md/);
  const pages = pagesForBrief(brief);
  assert.ok(pages.includes("src/pages/guides/learn/how-to/use-text.md"));
  assert.ok(pages.includes("src/pages/guides/learn/how-to/position-elements.md"));
  assert.ok(pages.includes("src/pages/guides/learn/how-to/resize-elements.md"));
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
    "manifest.json": manifest({
      entryPoints: [{ type: "panel", id: "panel1", main: "index.html", permissions: { oauth: ["www.dropbox.com"] } }]
    }),
    "index.html": "<!doctype html><html><body><button id=\"connect\">Connect Dropbox</button></body></html>\n",
    "index.js": "try {\n  const token = await addOnUISdk.app.oauth.authorize();\n  await addOnUISdk.instance.clientStorage.setItem(\"token\", token);\n} catch (error) {\n  console.error(error);\n}\n"
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
