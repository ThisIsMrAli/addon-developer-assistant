import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchDevelop } from "../.claude/skills/express-addon-develop/scripts/lib/session-start.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const reviewSkill = path.join(root, ".claude/skills/express-addon-review");
export const developSkill = path.join(root, ".claude/skills/express-addon-develop");
export const sessionCli = path.join(reviewSkill, "scripts/session.mjs");
export const dashboardCli = path.join(reviewSkill, "scripts/dashboard.mjs");
export const reviewCli = path.join(reviewSkill, "scripts/review.mjs");
export const developCli = path.join(developSkill, "scripts/develop.mjs");
export const setupCli = path.join(developSkill, "scripts/setup-express-linux.mjs");
export const expressRunCli = path.join(developSkill, "scripts/express-run.mjs");
export const blockFetch = path.join(root, "test/block-fetch.mjs");
export const preloadFixtures = path.join(root, "test/preload-fixtures.mjs");

/** Offline Adobe page sentences the develop tests need when `references/live` is empty (it is gitignored). */
export function seedLiveDocs() {
  const root = path.join(reviewSkill, "references/live");
  const pages = {
    "src/pages/guides/learn/platform-concepts/architecture.md": [
      "# Architecture",
      "",
      "The user interface environment runs in an iframe runtime, isolated from each other and from the host.",
      "Document APIs directly from the iframe runtime are not available; use the document sandbox.",
      "The document sandbox cannot call fetch().",
      "Add text, images, and shapes through the document sandbox.",
      "editor.createText() creates text. addImage() places a bitmap.",
      "OAuth and clientStorage run in the iframe runtime; the manifest must allow them.",
      ""
    ].join("\n"),
    "src/pages/guides/learn/platform-concepts/document-api.md": "# Document API\n\nDocument sandbox APIs edit the Express document.\n",
    "src/pages/guides/learn/platform-concepts/context.md": "# Context\n\nRuntime context for iframe and document sandbox.\n",
    "src/pages/guides/build/design/implementation-guide.md": "# Implementation guide\n\nPrefer Spectrum Web Components for Express add-on UI, with the Express theme.\n",
    "src/pages/guides/getting-started/local-development/dev-tooling.md": "# Dev tooling\n\nUse create-ccweb-add-on and ccweb-add-on-scripts.\n",
    "src/pages/guides/getting-started/addon-project-anatomy.md": "# Project anatomy\n\nManifest, iframe, and document sandbox entry points.\n",
    "src/pages/guides/learn/how-to/use-text.md": "# Use text\n\neditor.createText() adds text. Read insertionParent width and height.\n",
    "src/pages/guides/learn/how-to/position-elements.md": "# Position elements\n\nUse setPositionInParent and boundsInParent.\n",
    "src/pages/guides/learn/how-to/resize-elements.md": "# Resize elements\n\nUse resize() with ResizeBehavior.contain.\n",
    "src/pages/guides/learn/how-to/use-images.md": "# Use images\n\nkeepContentActiveDuringAsync and createImageContainer.\n"
  };
  let wrote = false;
  for (const [rel, body] of Object.entries(pages)) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) {
      // Refresh a thin seed that is missing sentences the classifier tests need.
      if (rel.endsWith("architecture.md") && !fs.readFileSync(file, "utf8").includes("OAuth")) {
        fs.writeFileSync(file, body);
        wrote = true;
      }
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    wrote = true;
  }
  return wrote;
}

seedLiveDocs();

export function parseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // One command, one JSON object, even when a progress line sits above it.
  }
  const line = text.split("\n").map((item) => item.trim()).filter((item) => item.startsWith("{")).at(-1);
  return line ? JSON.parse(line) : null;
}

export function run(file, args, env, imports = []) {
  const result = spawnSync(process.execPath, [...imports.flatMap((item) => ["--import", item]), file, ...args], {
    encoding: "utf8",
    env,
    timeout: 600000
  });
  return { ...result, json: parseJson(result.stdout) };
}

function tokenize(command) {
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match = pattern.exec(command);
  while (match) {
    tokens.push(match[1] ?? match[2]);
    match = pattern.exec(command);
  }
  return tokens;
}

function runSpoken(out, command, env, imports) {
  const tokens = tokenize(command);
  const script = tokens.find((item) => item.endsWith(".mjs"));
  if (!script) throw new Error(`No script in: ${command}`);
  const argv = [...tokens.slice(tokens.indexOf(script) + 1), "--out", out];
  let file = script;
  const extra = [];
  if (script.endsWith("/session.mjs") || script.endsWith("session.mjs")) file = sessionCli;
  else if (script.endsWith("dashboard.mjs")) file = dashboardCli;
  else if (script.endsWith("develop.mjs")) {
    file = developCli;
    extra.push(...imports);
  } else if (script.endsWith("setup-express-linux.mjs")) file = setupCli;
  else if (script.endsWith("express-run.mjs")) file = expressRunCli;
  else throw new Error(`Unexpected command: ${command}`);
  return run(file, argv, env, extra);
}

/**
 * Walk `session.mjs next` until the session is finished.
 * `audit: "skip"` records a stand-in result without Chrome.
 * `imports` are Node --import hooks for develop.mjs (fixture templates, or a fetch that throws).
 */
export function drive(out, env, { imports = [], audit = "skip", answers = {} } = {}) {
  const asked = [];
  const actions = [];
  let previousAsk = "";
  seedLiveDocs();
  for (let i = 0; i < 64; i += 1) {
    const next = run(sessionCli, ["next", "--out", out], env);
    assert.equal(next.status, 0, next.stdout + next.stderr);
    const action = next.json;
    actions.push(action.ask ? `${action.action}:${action.ask}` : action.action);
    if (action.action === "finished") return { asked, actions, action };
    if (action.action === "ask-mode") {
      const mode = run(sessionCli, ["mode", "--set", "chat", "--out", out], env);
      assert.equal(mode.status, 0, mode.stdout + mode.stderr);
      continue;
    }
    if (action.action === "ask" || action.action === "ask-in-chat") {
      const id = action.ask;
      if (previousAsk === "express" && (answers.express || "skip") === "skip") {
        assert.equal(id, "listing", "skipping the Express step continues straight to the listing");
        assert.match(action.command, /ask --id listing/);
      }
      previousAsk = id;
      asked.push(id);
      const ask = run(sessionCli, ["ask", "--id", id, "--out", out], env);
      assert.equal(ask.status, 0, ask.stdout + ask.stderr);
      if (env.EXPRESS_REVIEW_EXPECT_CHAT) assert.match(ask.stdout, /AskQuestion/);
      const value = answers[id] || defaultAnswer(id, out);
      const answer = run(sessionCli, ["answer", "--id", id, "--value", value, "--out", out], env);
      assert.equal(answer.status, 0, `${id}=${value}\n${answer.stdout}\n${answer.stderr}`);
      const waited = run(sessionCli, ["wait", "--id", id, "--timeout", "1", "--out", out], env);
      assert.equal(waited.json?.status, "answered", waited.stdout + waited.stderr);
      continue;
    }
    if (action.action === "finish") {
      const ran = runSpoken(out, action.command, env, imports);
      assert.equal(ran.status, 0, ran.stdout + ran.stderr);
      continue;
    }
    if (action.action === "apply") {
      // Bug-report round: tests answer feedback with "good", so this should not appear.
      throw new Error(`Unexpected apply action in drive: ${action.say}`);
    }
    if (String(action.command || "").includes("develop.mjs audit") && audit === "skip") {
      patchDevelop(out, { audited: true, standIn: "express-sdk-stand-in", expressPass: false, auditBugs: [] });
      run(sessionCli, ["step", "--id", "audit", "--status", "done", "--detail", "Audit skipped in test", "--out", out], env);
      continue;
    }
    if (String(action.command || "").includes("develop.mjs feedback") && (answers.feedback || "good") === "good") {
      const skipped = run(developCli, ["feedback", "--skip", "--out", out], env);
      assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
      continue;
    }
    if (action.action === "awaiting-agent-implementation") writeCaption(out);
    assert.ok(action.command, JSON.stringify(action));
    const ran = runSpoken(out, action.command, env, imports);
    assert.equal(ran.status, 0, `${action.command}\n${ran.stdout}\n${ran.stderr}`);
  }
  assert.fail(`the session did not finish: ${actions.join(" > ")}`);
}

function writeCaption(out) {
  const session = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
  const dir = session.addon.path;
  const htmlPath = fs.existsSync(path.join(dir, "src/index.html")) ? path.join(dir, "src/index.html") : path.join(dir, "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  if (html.includes("caption-field")) return;
  const block = `<label for="caption-field">Caption</label>\n<input id="caption-field" name="caption" type="text" />\n`;
  fs.writeFileSync(htmlPath, html.includes("</body>") ? html.replace("</body>", `${block}</body>`) : `${html}\n${block}`);
}

function defaultAnswer(id, out) {
  if (id === "plan") return "build";
  if (id === "goal") return "Add a caption field to the panel";
  if (id === "name") return "Caption Panel";
  if (id === "description") return "A text field and a button that adds the caption.";
  if (id === "tweak") return "name it Caption Panel";
  if (id === "origin") return "new";
  if (id === "template") {
    const session = JSON.parse(read(out));
    const ids = session.templates?.ids || [];
    if (ids.includes("javascript")) return "javascript";
    if (!ids.length) throw new Error("No template ids were fetched.");
    return ids[0];
  }
  if (id === "feasibility") return "iframe";
  if (id === "design") return "leave";
  if (id === "feedback") return "good";
  if (id === "express") return "skip";
  if (id === "express-result") return "skip";
  if (id === "listing") return "skip";
  if (id === "listing-review" || id === "shots-review") return "approve";
  if (String(id).startsWith("feat-")) return "stack";
  throw new Error(`No scripted answer for ${id}`);
}

function read(out) {
  return fs.readFileSync(path.join(out, "session.json"), "utf8");
}
