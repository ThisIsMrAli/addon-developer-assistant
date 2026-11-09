import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../.claude/skills/express-addon-review/scripts/lib/chrome.mjs";
import { launch } from "../.claude/skills/express-addon-review/scripts/lib/cdp.mjs";
import { mutate, publishAsk, startSession } from "../.claude/skills/express-addon-review/scripts/lib/session.mjs";
import { checkJsSyntax, controlFlow, storageKinds } from "../.claude/skills/express-addon-develop/scripts/lib/code-scan.mjs";
import { CREATE_CCWEB_ADD_ON, MANIFEST_NAME, TEXT_INSIDE_PAGE, applyManifestName, manifestDisplayName, scrubTemplateChrome, verifyFeature } from "../.claude/skills/express-addon-develop/scripts/lib/implement.mjs";
import { classifyFeature, plainSentence } from "../.claude/skills/express-addon-develop/scripts/lib/feasibility.mjs";
import { developNext } from "../.claude/skills/express-addon-develop/scripts/lib/flow.mjs";
import { listingFrom } from "../.claude/skills/express-addon-develop/scripts/lib/listing-copy.mjs";
import { prepareExpressRun } from "../.claude/skills/express-addon-develop/scripts/lib/express-host.mjs";
import { startDevelopSession, patchDevelop, setStep } from "../.claude/skills/express-addon-develop/scripts/lib/session-start.mjs";
import { STANDIN_SOURCE, serveWithStandIn } from "../.claude/skills/express-addon-develop/scripts/lib/standin.mjs";
import { devcertReady, domainCertPath, prepareDevCa, releaseSudoGuard, sudoGuard, SYSTEM_CA } from "../.claude/skills/express-addon-develop/scripts/lib/ssl-setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reviewSkill = path.join(root, ".claude/skills/express-addon-review");
const RAW = "https://raw.githubusercontent.com/adobe/create-ccweb-add-on/main/packages/create-ccweb-add-on";
const TEMPLATE_ROOT = "packages/create-ccweb-add-on/templates";
const browser = process.env.SKIP_BROWSER_TESTS
  ? { skip: "The box runner does not start Chrome or Edge. Set BOX_TEST_BROWSER=1 to run it." }
  : findChrome()
    ? {}
    : { skip: "No Chrome, Edge, or Chromium was found." };

const manifest = (point = {}) => `${JSON.stringify({
  name: "Sample",
  testId: "11111111-1111-4111-8111-111111111111",
  version: "1.0.0",
  manifestVersion: 2,
  requirements: { apps: [{ name: "Express", apiVersion: 1 }] },
  entryPoints: [{ type: "panel", id: "panel1", main: "index.html", documentSandbox: "code.js", ...point }]
}, null, 2)}\n`;

function addon(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ny-addon-"));
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

async function officialTree() {
  const cache = path.join(os.tmpdir(), "ccweb-template-tree.json");
  if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 24 * 60 * 60 * 1000) {
    return JSON.parse(fs.readFileSync(cache, "utf8"));
  }
  const response = await fetch("https://api.github.com/repos/adobe/create-ccweb-add-on/git/trees/main?recursive=1");
  if (!response.ok) throw new Error(`GitHub tree ${response.status}`);
  const body = await response.json();
  const files = body.tree
    .filter((item) => item.type === "blob" && item.path.startsWith(`${TEMPLATE_ROOT}/`) && !item.path.includes("/node_modules/"))
    .map((item) => item.path.slice(TEMPLATE_ROOT.length + 1));
  fs.writeFileSync(cache, JSON.stringify(files));
  return files;
}

async function officialTemplate(id) {
  const dest = path.join(os.tmpdir(), "ccweb-templates", id);
  const marker = path.join(dest, ".complete");
  if (fs.existsSync(marker)) return dest;
  const files = (await officialTree()).filter((file) => file.startsWith(`${id}/template/`));
  assert.ok(files.length > 3, `${id} has no source files`);
  fs.rmSync(dest, { recursive: true, force: true });
  for (const file of files) {
    const rel = file.slice(`${id}/template/`.length);
    const response = await fetch(`${RAW}/templates/${file}`);
    if (!response.ok) throw new Error(`${file} ${response.status}`);
    const full = path.join(dest, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(await response.arrayBuffer()));
  }
  fs.writeFileSync(marker, `${files.length}\n`);
  return dest;
}

test("NY1 every official ccweb-add-on template parses, and a syntax error is the parser message", { timeout: 180_000 }, async () => {
  const constants = await (await fetch(`${RAW}/src/constants.ts`)).text();
  const names = [...constants.matchAll(/"(javascript|swc-javascript|swc-typescript|react-javascript|react-typescript)"/g)].map((match) => match[1]);
  const base = [...new Set(names)];
  assert.ok(constants.includes("WITH_DOCUMENT_SANDBOX"));
  const unique = [...base, ...base.map((id) => `${id}-with-document-sandbox`)];
  assert.equal(unique.length, 10, unique.join(","));
  for (const id of unique) {
    const dir = await officialTemplate(id);
    const sources = [];
    const walk = (folder) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(mjs|cjs|jsx?|tsx?)$/i.test(entry.name)) sources.push(full);
      }
    };
    walk(dir);
    assert.ok(sources.length > 0, id);
    for (const file of sources) {
      const error = checkJsSyntax(file);
      assert.equal(error, "", `${id} ${path.relative(dir, file)} ${error}`);
    }
  }
  const swc = await officialTemplate("swc-javascript-with-document-sandbox");
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny1-"));
  const broken = path.join(brokenDir, "index.js");
  fs.writeFileSync(broken, `${fs.readFileSync(path.join(swc, "src/ui/index.js"), "utf8")}\nfunction (\n`);
  const error = checkJsSyntax(broken);
  assert.match(error, /index\.js:\d+/);
  assert.match(error, /Unexpected token|SyntaxError/);
  assert.doesNotMatch(error, /endReadableNT|Node\.js v/);
});

test("NY2 a real SWC panel is judged from its script, and a loading placeholder is not the listing", async () => {
  const swc = await officialTemplate("swc-javascript-with-document-sandbox");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ny2-"));
  fs.cpSync(path.join(swc, "src"), path.join(dir, "src"), { recursive: true });
  applyManifestName(dir, "heading-panel");
  scrubTemplateChrome(dir, "heading-panel");
  fs.writeFileSync(path.join(dir, "src/sandbox/code.js"), TEXT_INSIDE_PAGE);
  const htmlPath = path.join(dir, "src/index.html");
  const html = fs.readFileSync(htmlPath, "utf8").replace("</body>", "<p>Loading Heading Image…</p></body>");
  fs.writeFileSync(htmlPath, html);
  const appPath = path.join(dir, "src/ui/components/App.js");
  fs.writeFileSync(appPath, fs.readFileSync(appPath, "utf8").replace("Create Rectangle", "Insert heading"));
  const ok = verifyFeature({ dir, brief: "Add a styled heading to the document and a Spectrum panel with a form", build: false });
  assert.equal(ok.ok, true, ok.problems.join(" "));
  assert.doesNotMatch(ok.problems.join(" "), /blank|Spectrum|does not parse/);
  const listing = listingFrom({ name: "Heading Image", dir });
  assert.doesNotMatch(listing.summary, /loading/i);
  assert.equal(listing.keywords.includes("loading"), false);
  assert.match(listing.summary, /Insert heading/);
});

test("b v2 and two variants fail on a real SWC template, and the real button passes", async () => {
  const swc = await officialTemplate("swc-javascript-with-document-sandbox");
  const brief = "Add a Spectrum panel with a form";
  const base = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ny-b-"));
    fs.cpSync(path.join(swc, "src"), path.join(dir, "src"), { recursive: true });
    applyManifestName(dir, "heading-panel");
    scrubTemplateChrome(dir, "heading-panel");
    return dir;
  };
  const replaceRender = (dir, body) => {
    const file = path.join(dir, "src/ui/components/App.js");
    const source = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, source.replace(/return html`[\s\S]*?`;/, `return html\`${body}\`;`));
  };
  const good = base();
  const passed = verifyFeature({ dir: good, brief, build: false });
  assert.equal(passed.ok, true, passed.problems.join(" "));

  const comment = base();
  replaceRender(comment, "<!-- <sp-button>Go</sp-button> --><input>");
  const commentResult = verifyFeature({ dir: comment, brief, build: false });
  assert.equal(commentResult.ok, false, commentResult.problems.join(" "));
  assert.match(commentResult.problems.join(" "), /Spectrum|sp-button|comment/);

  const theme = base();
  replaceRender(theme, "<sp-theme><input></sp-theme><!-- <sp-button>Go</sp-button> -->");
  const themeResult = verifyFeature({ dir: theme, brief, build: false });
  assert.equal(themeResult.ok, false);
  assert.match(themeResult.problems.join(" "), /Spectrum/);

  const stringOnly = base();
  const file = path.join(stringOnly, "src/ui/components/App.js");
  const source = fs.readFileSync(file, "utf8").replace(/return html`[\s\S]*?`;/, "const unused = \"<sp-button>Go</sp-button>\";\n        return html`<input>`;");
  fs.writeFileSync(file, source);
  const stringResult = verifyFeature({ dir: stringOnly, brief, build: false });
  assert.equal(stringResult.ok, false);
  assert.match(stringResult.problems.join(" "), /Spectrum/);
});

test("NX4 a clientStorage parameter bound to localStorage is rejected, and a catch elsewhere does not cover a throw", () => {
  const oauth = "Connect Dropbox with OAuth and clientStorage";
  const passed = addon({
    "manifest.json": manifest({ permissions: { oauth: ["www.dropbox.com"] } }),
    "index.html": "<!doctype html><html><body><button>Connect</button></body></html>\n",
    "index.js": "function save(clientStorage) { return clientStorage.setItem(\"token\", token); }\nsave(localStorage);\ntry { await addOnUISdk.app.oauth.authorize(); } catch (error) {}\n"
  });
  const result = verifyFeature({ dir: passed, brief: oauth, build: false });
  assert.equal(result.ok, false, result.problems.join(" "));
  assert.match(result.problems.join(" "), /localStorage/);
  const real = storageKinds([{ rel: "index.js", text: "await addOnUISdk.instance.clientStorage.setItem(\"token\", token);\n" }]);
  assert.equal(real.client, true);

  const elsewhere = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add heading</button></body></html>\n",
    "index.js": "throw new Error(\"boom\");\n",
    "other.js": "try { 1 } catch (error) {}\n",
    "code.js": TEXT_INSIDE_PAGE
  });
  const thrown = verifyFeature({ dir: elsewhere, brief: "Add styled text to the document", build: false });
  assert.equal(thrown.ok, false);
  assert.match(thrown.problems.join(" "), /throws/);
  const helper = controlFlow([{ rel: "index.js", text: "async function signIn() { await addOnUISdk.app.oauth.authorize(); }\ntry { await signIn(); } catch (error) {}\n" }]);
  assert.equal(helper.unhandledAuthorize, false);
});

test("NY5 a short heading stays inside a 1920x1080 page and a width-only resize is rejected", () => {
  const old = `import { editor, constants } from "express-document-sdk";
export function addHeading(heading) {
  const page = editor.context.insertionParent;
  const textNode = editor.createText(heading);
  const margin = Math.round(Math.min(page.width, page.height) * 0.08);
  const maxWidth = Math.max(32, page.width - margin * 2);
  page.children.append(textNode);
  textNode.resize({ width: maxWidth, behavior: constants.ResizeBehavior.contain, avoidScalingVisualDetailsIfPossible: false });
  const box = textNode.boundsLocal;
  textNode.setPositionInParent({ x: page.width / 2, y: page.height / 2 }, textNode.centerPointLocal || { x: box.x + box.width / 2, y: box.y + box.height / 2 });
}
`;
  const loose = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add heading</button></body></html>\n",
    "code.js": old
  });
  const rejected = verifyFeature({ dir: loose, brief: "Add styled text to the document", build: false });
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join(" "), /width|height|cap|edge/);

  function place(source, pageW, pageH, text) {
    class Text {
      constructor(value) { this.t = value; this.fs = 100; this.translation = { x: 0, y: 0 }; }
      get boundsLocal() { return { x: 0, y: 0, width: 0.55 * this.fs * this.t.length, height: 1.2 * this.fs }; }
      get boundsInParent() { const box = this.boundsLocal; return { x: this.translation.x, y: this.translation.y, width: box.width, height: box.height }; }
      get centerPointLocal() { const box = this.boundsLocal; return { x: box.width / 2, y: box.height / 2 }; }
      get fullContent() { const self = this; return { applyCharacterStyles(style) { if (style.fontSize) self.fs = style.fontSize; } }; }
      resize({ width, height, behavior }) {
        const box = this.boundsLocal;
        let scale = width / box.width;
        if (height && behavior === "contain") scale = Math.min(scale, height / box.height);
        this.fs *= scale;
      }
      setPositionInParent(point, ref) { this.translation = { x: point.x - ref.x, y: point.y - ref.y }; }
    }
    const children = { items: [], append(node) { this.items.push(node); }, [Symbol.iterator]() { return this.items[Symbol.iterator](); } };
    const page = { width: pageW, height: pageH, children };
    const editor = { context: { insertionParent: page, selection: [] }, createText: (value) => new Text(value) };
    const body = source.replace(/^import[^\n]*\n/gm, "").replace(/export\s+(?:async\s+)?function/g, (match) => match.replace(/^export\s+/, ""));
    const fn = new Function("editor", "constants", `${body}\nreturn addHeading;`)(editor, { ResizeBehavior: { contain: "contain" } });
    fn(text);
    const node = page.children.items[0];
    const box = node.boundsLocal;
    return {
      fontSize: node.fs,
      inside: node.translation.x >= -0.5 && node.translation.y >= -0.5 && node.translation.x + box.width <= pageW + 0.5 && node.translation.y + box.height <= pageH + 0.5
    };
  }
  const hi = place(TEXT_INSIDE_PAGE, 1920, 1080, "Hi");
  assert.ok(hi.fontSize <= 72, `font ${hi.fontSize}`);
  assert.equal(hi.inside, true);
  for (const [width, height, text] of [[1080, 1080, "Real Express test"], [1080, 1920, "A very long heading that keeps going and going across the page"], [1080, 1080, "Hi"]]) {
    const laid = place(TEXT_INSIDE_PAGE, width, height, text);
    assert.equal(laid.inside, true, `${width}x${height} ${text} font ${laid.fontSize}`);
    assert.ok(laid.fontSize <= 72, `${laid.fontSize}`);
  }
  const blown = place(old, 1920, 1080, "Hi");
  assert.ok(blown.fontSize > 200);
  assert.equal(blown.inside, false);
});

test("NY12 consecutive headings do not share one position", () => {
  const sameSpot = `import { editor, constants } from "express-document-sdk";
export function addHeading(heading) {
  const page = editor.context.insertionParent;
  const textNode = editor.createText(heading);
  const margin = Math.round(Math.min(page.width, page.height) * 0.08);
  const maxWidth = Math.max(32, page.width - margin * 2);
  const maxHeight = Math.max(32, page.height - margin * 2);
  const cap = Math.min(72, Math.round(page.width / 16));
  page.children.append(textNode);
  textNode.fullContent.applyCharacterStyles({ fontSize: cap }, { start: 0, length: heading.length });
  const box = textNode.boundsLocal;
  if (box.width > maxWidth || box.height > maxHeight) {
    textNode.resize({ width: maxWidth, height: maxHeight, behavior: constants.ResizeBehavior.contain, avoidScalingVisualDetailsIfPossible: false });
  }
  const fitted = textNode.boundsLocal;
  textNode.setPositionInParent({ x: page.width / 2, y: page.height / 2 }, textNode.centerPointLocal || { x: fitted.x + fitted.width / 2, y: fitted.y + fitted.height / 2 });
}
`;
  const stackedOnly = addon({
    "manifest.json": manifest(),
    "index.html": "<!doctype html><html><body><button>Add heading</button></body></html>\n",
    "code.js": sameSpot
  });
  const rejected = verifyFeature({ dir: stackedOnly, brief: "Add styled text to the document", build: false });
  assert.equal(rejected.ok, false, rejected.problems.join(" "));
  assert.match(rejected.problems.join(" "), /overlap|boundsInParent|selection/);

  class Text {
    constructor(value) { this.t = value; this.fs = 100; this.translation = { x: 0, y: 0 }; }
    get boundsLocal() { return { x: 0, y: 0, width: 0.55 * this.fs * this.t.length, height: 1.2 * this.fs }; }
    get boundsInParent() { const box = this.boundsLocal; return { x: this.translation.x, y: this.translation.y, width: box.width, height: box.height }; }
    get centerPointLocal() { const box = this.boundsLocal; return { x: box.width / 2, y: box.height / 2 }; }
    get fullContent() { const self = this; return { applyCharacterStyles(style) { if (style.fontSize) self.fs = style.fontSize; } }; }
    resize({ width, height, behavior }) {
      const box = this.boundsLocal;
      let scale = width / box.width;
      if (height && behavior === "contain") scale = Math.min(scale, height / box.height);
      this.fs *= scale;
    }
    setPositionInParent(point, ref) { this.translation = { x: point.x - ref.x, y: point.y - ref.y }; }
  }
  function pageOf(width, height, selection = []) {
    const children = { items: [], append(node) { this.items.push(node); }, [Symbol.iterator]() { return this.items[Symbol.iterator](); } };
    const page = { width, height, children };
    const editor = { context: { insertionParent: page, selection }, createText: (value) => new Text(value) };
    return { page, editor };
  }
  function load(editor) {
    const body = TEXT_INSIDE_PAGE.replace(/^import[^\n]*\n/gm, "").replace(/export\s+(?:async\s+)?function/g, (match) => match.replace(/^export\s+/, ""));
    return new Function("editor", "constants", `${body}\nreturn addHeading;`)(editor, { ResizeBehavior: { contain: "contain" } });
  }
  function boxOf(node) {
    const box = node.boundsInParent;
    return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
  }
  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }
  const { page, editor } = pageOf(1920, 1080);
  const add = load(editor);
  add("Hi");
  add("There");
  const boxes = page.children.items.map(boxOf);
  assert.equal(boxes.length, 2);
  assert.equal(overlaps(boxes[0], boxes[1]), false);
  for (const box of boxes) {
    assert.ok(box.left >= -0.5 && box.top >= -0.5 && box.right <= 1920.5 && box.bottom <= 1080.5, JSON.stringify(box));
  }
  assert.ok(boxes[1].top >= boxes[0].bottom - 0.5);
  assert.ok(page.children.items[0].fs <= 72 && page.children.items[1].fs <= 72);

  const selected = new Text("Already here");
  selected.fs = 40;
  selected.translation = { x: 400, y: 80 };
  const under = pageOf(1920, 1080, [selected]);
  load(under.editor)("Next");
  const next = boxOf(under.page.children.items[0]);
  const prior = boxOf(selected);
  assert.equal(overlaps(next, prior), false);
  assert.ok(next.top >= prior.bottom - 0.5);
  assert.ok(next.bottom <= 1080.5);
});

test("NY6 skip reasons are separate sentences", () => {
  const prepared = prepareExpressRun({
    env: { EXPRESS_DEVELOP_REMOTE: "1", EXPRESS_DEVELOP_POLICY_DIRS: "" },
    probe: { cgroup: "", dockerenv: false, containerenv: false },
    policyDirs: [fs.mkdtempSync(path.join(os.tmpdir(), "ny6-"))]
  });
  const withPolicy = prepareExpressRun({
    env: { EXPRESS_DEVELOP_REMOTE: "1" },
    probe: { cgroup: "", dockerenv: false, containerenv: false },
    policy: { blocks: true }
  });
  assert.match(withPolicy.reason, /EXPRESS_DEVELOP_REMOTE=1\. Chrome policy/);
  assert.match(prepared.reason, /EXPRESS_DEVELOP_REMOTE=1/);
});

test("NY8 feasibility evidence is plain text", () => {
  const raw = "Use `editor.createRectangle()`, `editor.createText()` - Create content<br/>• `editor.createText()`.";
  const plain = plainSentence(raw);
  assert.doesNotMatch(plain, /`|<br|•/);
  const encoded = plainSentence("createRectangle(), editor.createText() - Create content&lt;br/&gt;• editor.");
  assert.doesNotMatch(encoded, /&lt;|&gt;|<br|br\/|`|•/);
  const page = `The iframe can call editor.createRectangle(), editor.createText() - Create content<br/>• editor.createText() for the document sandbox.`;
  const found = classifyFeature("Add a heading to the document", {
    architecture: page,
    document: "",
    guide: "Spectrum Web Components",
    label: "fresh"
  });
  assert.doesNotMatch(found.summary, /`|<br|createRectangle|br\//);
});

test("NY9 a failed record is not a finished review", () => {
  const next = developNext({
    kind: "develop",
    mode: "chat",
    steps: [{ id: "done", status: "done" }],
    asks: [],
    develop: { implemented: false, verify: { ok: false, problems: ["The panel is blank"] } }
  });
  assert.equal(next.action, "run");
  assert.match(next.command, /develop\.mjs record/);
  assert.match(next.say, /Record failed/);
  assert.doesNotMatch(next.say, /finished/);
});

test("NY3 the stand-in loads as a browser module and apiProxy resolves", { ...browser, timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ny3-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><script type=\"module\" src=\"./sdk-stand-in.js\"></script>\n");
  fs.writeFileSync(path.join(dir, "sdk-stand-in.js"), STANDIN_SOURCE);
  const served = await serveWithStandIn(dir);
  const page = await launch({ width: 800, height: 600 });
  try {
    await page.goto(served.url);
    const value = await page.eval(`(async () => {
      const sdk = await import("./sdk-stand-in.js");
      const proxy = await Promise.race([
        sdk.default.instance.runtime.apiProxy("documentSandbox"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("apiProxy still pending")), 2000))
      ]);
      return { thenType: typeof proxy.then, created: typeof proxy.createRectangle, runtime: sdk.RuntimeType.documentSandbox, exceptions: [] };
    })()`);
    assert.equal(value.thenType, "undefined");
    assert.equal(value.created, "function");
    assert.equal(value.runtime, "documentSandbox");
    assert.equal(page.seen.exceptions.some((item) => /Duplicate export/.test(item)), false, page.seen.exceptions.join(" "));
  } finally {
    await page.close();
    await served.close();
  }
});

function copyDist(from, to) {
  fs.cpSync(from, to, { recursive: true });
}

test("NY4 the real audit passes a visible official panel and fails a blank one and an unhandled error", { ...browser, timeout: 300_000 }, async () => {
  const project = await officialBuild();
  const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny4-good-"));
  copyDist(path.join(project, "dist"), goodDir);
  const good = await auditDir(goodDir);
  assert.equal(good.result.ok, true, JSON.stringify(good.result.bugs));
  assert.equal(good.result.rendered, true);
  assert.equal(good.result.bugs.length, 0);
  const shot = fs.readdirSync(good.out, { recursive: true }).find((name) => String(name).endsWith(".png"));
  assert.ok(shot, "the walk wrote a screenshot");

  const blankDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny4-blank-"));
  copyDist(path.join(project, "dist"), blankDir);
  fs.writeFileSync(path.join(blankDir, "index.html"), "<!doctype html><html><body></body></html>\n");
  fs.writeFileSync(path.join(blankDir, "index.js"), "console.log('no panel');\n");
  const blank = await auditDir(blankDir);
  assert.equal(blank.result.ok, false);
  assert.match(blank.result.bugs.map((bug) => bug.text).join(" "), /nothing|blank/i);

  const errorDir = fs.mkdtempSync(path.join(os.tmpdir(), "ny4-error-"));
  copyDist(path.join(project, "dist"), errorDir);
  const page = fs.readFileSync(path.join(errorDir, "index.html"), "utf8").replace("<body>", "<body><script>throw new Error('unhandled panel');</script>");
  fs.writeFileSync(path.join(errorDir, "index.html"), page);
  const broken = await auditDir(errorDir);
  assert.equal(broken.result.ok, false);
  assert.match(broken.result.bugs.map((bug) => `${bug.rule} ${bug.text}`).join(" "), /script-error|unhandled panel/);
});

let officialProject;

function officialBuild() {
  if (!officialProject) officialProject = scaffoldOfficialProject();
  return officialProject;
}

async function scaffoldOfficialProject() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "official-swc-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "official-scaffold-home-"));
  const dir = path.join(parent, "heading-panel");
  const created = spawnSync("npx", ["--yes", CREATE_CCWEB_ADD_ON, "heading-panel", "--template", "swc-javascript-with-document-sandbox", "--analytics", "off"], {
    cwd: parent,
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, CI: "1", npm_config_yes: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false" }
  });
  const log = `${created.stdout || ""}\n${created.stderr || ""}`;
  const manifestPath = path.join(dir, "src/manifest.json");
  assert.equal(fs.existsSync(manifestPath), true, log.slice(-1200));
  assert.doesNotMatch(log, /Do you want to allow sending analytics/);
  const written = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.match(written.name, MANIFEST_NAME, written.name);
  assert.equal(written.name, "Heading Panel");
  assert.ok(String(written.testId || "").trim(), "the scaffolder writes testId");
  const real = fs.realpathSync(dir);
  const temp = fs.realpathSync(os.tmpdir());
  assert.ok(real.startsWith(`${temp}${path.sep}`), real);
  assert.equal(real.includes(`${path.sep}official-heading${path.sep}`), false, real);
  const built = spawnSync("npm", ["run", "build", "--", "--analytics", "off"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 240_000,
    env: { ...process.env, HOME: home, CI: "1" }
  });
  const buildLog = `${built.stdout || ""}\n${built.stderr || ""}`;
  assert.equal(built.status, 0, buildLog.slice(-1200));
  assert.doesNotMatch(buildLog, /Do you want to allow sending analytics|manifest validation failed|unsettled top-level await/);
  return dir;
}

function auditDir(dir) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ny4-out-"));
  const report = { ok: true, findings: [], addon: "Official", projectPath: dir, views: [] };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report));
  startSession(out, report);
  return new Promise((resolve, reject) => {
    serveWithStandIn(dir).then((served) => {
      const child = spawn(process.execPath, [path.join(reviewSkill, "scripts/audit.mjs"), "--out", out, "--url", served.url], {
        env: { ...process.env, EXPRESS_REVIEW_NO_OPEN: "1" }
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", () => {
        served.close().finally(() => {
          const line = stdout.trim().split("\n").filter((item) => item.startsWith("{")).at(-1);
          if (!line) reject(new Error(stderr || stdout || "audit produced no JSON"));
          else resolve({ out, result: JSON.parse(line) });
        });
      });
    }).catch(reject);
  });
}

test("a hyphenated or placeholder manifest name and a missing testId are rejected", () => {
  assert.equal(manifestDisplayName("heading-panel"), "Heading Panel");
  assert.equal(manifestDisplayName("official-swc"), "Official Swc");
  assert.equal(manifestDisplayName("caption-addon"), "Caption Addon");
  assert.equal(manifestDisplayName("Color Note e"), "Color Note e");
  assert.equal(manifestDisplayName("placeholder"), "");
  assert.equal(manifestDisplayName(""), "");

  const page = "<!doctype html><html><body><button>Caption</button></body></html>\n";
  const code = "const caption = 'caption';\n";
  const brief = "Add a caption field to the panel";
  const base = { version: "1.0.0", manifestVersion: 2, requirements: { apps: [{ name: "Express", apiVersion: 1 }] }, entryPoints: [{ type: "panel", id: "panel1", main: "index.html" }] };
  const judge = (manifest) => verifyFeature({
    dir: addon({
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "index.html": page,
      "index.js": code
    }),
    brief,
    build: false
  });

  const hyphenated = judge({ ...base, name: "heading-panel", testId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(hyphenated.ok, false);
  assert.match(hyphenated.problems.join(" "), /heading-panel|hyphenated|does not match/);

  const placeholder = judge({ ...base, name: "placeholder", testId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(placeholder.ok, false);
  assert.match(placeholder.problems.join(" "), /placeholder/);

  const empty = judge({ ...base, name: "", testId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join(" "), /placeholder/);

  const missing = judge({ ...base, name: "Sample" });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join(" "), /testId/);
  assert.doesNotMatch(missing.problems.join(" "), /does not match/);

  const filled = addon({ "src/manifest.json": `${JSON.stringify({ ...base, name: "", testId: "" }, null, 2)}\n` });
  applyManifestName(filled, "heading-panel");
  const written = JSON.parse(fs.readFileSync(path.join(filled, "src/manifest.json"), "utf8"));
  assert.equal(written.name, "Heading Panel");
  assert.match(written.testId, /^[0-9a-f-]{36}$/i);

  const kept = addon({ "src/manifest.json": `${JSON.stringify({ ...base, name: "Old Name", testId: "keep-me" }, null, 2)}\n` });
  applyManifestName(kept, "Color Note e");
  const unchanged = JSON.parse(fs.readFileSync(path.join(kept, "src/manifest.json"), "utf8"));
  assert.equal(unchanged.name, "Color Note e");
  assert.equal(unchanged.testId, "keep-me");
});

test("NX10 npm start on a fresh HOME finds the localhost certificate", { timeout: 360_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ny-ssl-home-"));
  const before = fs.existsSync(SYSTEM_CA) ? fs.statSync(SYSTEM_CA).mtimeMs : 0;
  const prepared = prepareDevCa({ home });
  assert.equal(prepared.ok, true, prepared.error);
  assert.equal(devcertReady(home), true);
  assert.equal(fs.existsSync(domainCertPath(home)), true);
  const project = await officialBuild();
  const realProject = fs.realpathSync(project);
  assert.ok(realProject.startsWith(`${fs.realpathSync(os.tmpdir())}${path.sep}`), realProject);
  assert.equal(realProject.includes(`${path.sep}official-heading${path.sep}`), false, realProject);
  const built = spawnSync("npm", ["run", "build", "--", "--analytics", "off"], {
    cwd: project,
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, HOME: home, CI: "1" }
  });
  const buildLog = `${built.stdout || ""}\n${built.stderr || ""}`;
  assert.equal(built.status, 0, buildLog.slice(-1200));
  assert.doesNotMatch(buildLog, /Do you want to allow sending analytics|unsettled top-level await/);
  const guard = sudoGuard();
  const port = await freePort();
  const child = spawn("npm", ["start", "--", "--analytics", "off", "--port", String(port)], {
    cwd: project,
    detached: true,
    env: { ...process.env, HOME: home, CI: "1", PATH: `${guard}${path.delimiter}${process.env.PATH || ""}` }
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const started = Date.now();
  let listening = false;
  try {
    while (Date.now() - started < 60_000) {
      if (/Could not locate a valid SSL certificate/.test(log)) break;
      listening = await probe(port);
      if (listening) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } finally {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    releaseSudoGuard(guard);
  }
  assert.doesNotMatch(log, /Could not locate a valid SSL certificate/);
  assert.equal(listening, true, log.slice(-800));
  const after = fs.existsSync(SYSTEM_CA) ? fs.statSync(SYSTEM_CA).mtimeMs : 0;
  assert.equal(after, before);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "::1", port });
    const done = (value) => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(400);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

test("NY7 NY10 and X4 the dashboard tells the truth about files, a failed audit, and a clickable choice", { ...browser, timeout: 60_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ny-dash-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ny-dash-addon-"));
  startDevelopSession(out, { name: "Heading", dir, brief: "Add a heading" });
  mutate(out, (draft) => { draft.mode = "dashboard"; });
  patchDevelop(out, { implemented: false, files: Array.from({ length: 19 }, (_, index) => `src/file-${index}.js`) });
  setStep(out, "audit", "done", "Audit failed: 1 error");
  publishAsk(out, {
    id: "feasibility",
    title: "Feasibility",
    prompt: "Where does this feature run?",
    options: [
      { id: "sandbox", label: "Document sandbox APIs" },
      { id: "iframe", label: "iframe UI" }
    ]
  });
  fs.mkdirSync(path.join(out, "review"), { recursive: true });
  const codeReport = {
    findings: [{ id: "index-keywords", severity: "error", file: "src/index.html", line: 8, message: "index.html keywords mention Adobe Express and add-on.", suggestion: "Remove them from the page metadata." }]
  };
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(codeReport));
  fs.writeFileSync(path.join(out, "review/report.json"), JSON.stringify(codeReport));
  const started = spawnSync(process.execPath, [path.join(reviewSkill, "scripts/dashboard.mjs"), "start", "--out", out, "--no-open"], { encoding: "utf8" });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const info = JSON.parse(started.stdout);
  const page = await launch({ width: 1100, height: 640 });
  try {
    await page.goto(info.url);
    await page.eval(`new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        if (document.querySelector(".choices") || Date.now() - start > 8000) { clearInterval(timer); resolve(true); }
      }, 100);
    })`);
    await page.eval("document.querySelector('.choices').scrollIntoView({ block: 'start' })");
    const hit = await page.eval(`(() => {
      const bar = document.querySelector(".topbar").getBoundingClientRect().bottom;
      const radio = document.querySelector(".choice input").getBoundingClientRect();
      const files = [...document.querySelectorAll(".stat")].find((card) => card.textContent.includes("Files written"));
      const failed = document.querySelector('.step[data-failed="true"]');
      const finding = document.body.innerText;
      return { bar, top: radio.top, height: radio.height, files: files ? files.innerText : "", failed: Boolean(failed), finding };
    })()`);
    assert.ok(hit.top >= hit.bar - 1, `radio ${hit.top} is under the bar ${hit.bar}`);
    await page.click(400, hit.top + hit.height / 2);
    const chosen = await page.eval(`(() => {
      const radio = document.querySelector(".choice input");
      const box = radio.getBoundingClientRect();
      return { checked: radio.checked, left: box.left, width: box.width, disabled: document.querySelector("button.primary").disabled };
    })()`);
    await page.click(chosen.left + chosen.width / 2, hit.top + hit.height / 2);
    const after = await page.eval("({ checked: document.querySelector('.choice input').checked, disabled: document.querySelector('button.primary').disabled })");
    assert.equal(after.checked, true);
    assert.equal(after.disabled, false);
    assert.match(hit.files, /19/);
    assert.match(hit.files, /Written, not verified yet/);
    assert.doesNotMatch(hit.files, /Nothing is written before you approve/);
    assert.equal(hit.failed, true);
    assert.match(hit.finding, /index\.html keywords mention Adobe Express/);
    assert.doesNotMatch(hit.finding, /No code-error list/);
  } finally {
    await page.close();
    spawnSync(process.execPath, [path.join(reviewSkill, "scripts/dashboard.mjs"), "stop", "--out", out]);
  }
});

test("NY11 a sudo shim and a Chrome profile are removed", { ...browser, timeout: 40_000 }, async () => {
  const guard = sudoGuard();
  assert.equal(fs.existsSync(guard), true);
  releaseSudoGuard(guard);
  assert.equal(fs.existsSync(guard), false);
  const page = await launch({ width: 400, height: 300 });
  assert.match(page.profile, /express-addon-review-cdp-/);
  assert.equal(fs.existsSync(page.profile), true);
  assert.ok(page.scratch.startsWith(page.profile));
  assert.equal(fs.existsSync(page.scratch), true);
  await page.goto("about:blank");
  await page.close();
  assert.equal(fs.existsSync(page.profile), false);
  assert.equal(fs.existsSync(page.scratch), false);
});
