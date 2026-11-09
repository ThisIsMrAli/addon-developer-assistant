#!/usr/bin/env node
/**
 * Express Add-on Develop Assistant.
 *
 *   begin --dir <folder> --name <name> --brief "<feature>" [--out dir]
 *   docs [--budget 20000] [--page-timeout 8000]
 *   templates
 *   classify
 *   implement
 *   build
 *   package
 *   audit
 *   listing-text
 *
 * `begin` does not use the network. Mode is asked before docs.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { reminder } from "../../express-addon-review/scripts/lib/next.mjs";
import { readMerged, setListing } from "../../express-addon-review/scripts/lib/session.mjs";
import { fetchDevDocs } from "./lib/docs-live.mjs";
import { classifyFeature, pagesFromDisk } from "./lib/feasibility.mjs";
import { applyFeature, gate, scaffoldProject } from "./lib/implement.mjs";
import { buildProject, packageProject } from "./lib/package-addon.mjs";
import { liveDir, rememberedOut, reviewScripts } from "./lib/paths.mjs";
import { patchDevelop, saveDocs, saveFeasibility, saveTemplates, setStep, startDevelopSession } from "./lib/session-start.mjs";
import { builtDir, serveWithStandIn } from "./lib/standin.mjs";
import { fetchTemplates } from "./lib/templates.mjs";

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (command === "begin") begin();
  else if (command === "docs") await docs();
  else if (command === "templates") await templates();
  else if (command === "classify") classify();
  else if (command === "implement") implement();
  else if (command === "build") build();
  else if (command === "package") pack();
  else if (command === "audit") await audit();
  else if (command === "listing-text") listingText();
  else usage();
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exit(1);
}

function begin() {
  if (!args.dir) throw new Error("Use --dir for the empty folder or the existing add-on.");
  const out = path.resolve(args.out || path.join(path.dirname(path.resolve(args.dir)), `.develop-${path.basename(args.dir)}`));
  startDevelopSession(out, { name: args.name || path.basename(args.dir), dir: path.resolve(args.dir), brief: args.brief || "" });
  print({
    ok: true,
    out,
    network: false,
    next: "Ask the mode question in questions.json with AskQuestion, then `node scripts/session.mjs mode --set dashboard|chat`. Do not fetch the docs before that. Do not end your turn."
  }, null);
}

async function docs() {
  const out = resolveOut();
  const session = readMerged(out);
  if (!session?.mode) throw new Error("Set mode before fetching. Mode comes first, and this command is the network.");
  setStep(out, "docs", "running", "Fetching Adobe docs", { doing: "Fetching Adobe docs" });
  const result = await fetchDevDocs({
    budgetMs: Number(args.budget) || 20000,
    pageMs: Number(args["page-timeout"]) || 8000,
    cacheDir: liveDir,
    destDir: path.join(out, "docs")
  });
  saveDocs(out, result);
  const summaryPath = path.join(liveDir, "summary.json");
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch {
    previous = {};
  }
  const summary = {
    ...previous,
    fetchedAt: result.fetchedAt,
    develop: { counts: result.counts, elapsedMs: result.elapsedMs, budgetMs: result.budgetMs, pages: result.pages }
  };
  if (process.env.EXPRESS_DEVELOP_KEEP_CACHE !== "1") {
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  print({ ok: true, ...result }, out);
}

async function templates() {
  const out = resolveOut();
  const session = readMerged(out);
  const tooling = path.join(out, "docs", "src/pages/guides/getting-started/local-development/dev-tooling.md");
  const pageText = fs.existsSync(tooling) ? fs.readFileSync(tooling, "utf8") : "";
  const result = await fetchTemplates({ pageText });
  const stored = { ...result };
  delete stored.raw;
  saveTemplates(out, stored);
  fs.writeFileSync(path.join(out, "templates.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    print({ ok: false, error: result.note, ...stored }, out);
    process.exit(1);
  }
  print({ ok: true, ids: result.ids, source: result.source, npmVersion: result.npmVersion, note: result.note }, out);
  void session;
}

function classify() {
  const out = resolveOut();
  const session = readMerged(out);
  const pages = pagesFromDisk(out, session.docs);
  const feasibility = classifyFeature(session.brief, pages);
  saveFeasibility(out, feasibility);
  print({ ok: Boolean(feasibility.class), ...feasibility }, out);
}

function implement() {
  const out = resolveOut();
  const session = readMerged(out);
  const decision = gate(session);
  if (!decision.ok) throw new Error(decision.error);
  const dir = session.addon.path;
  if (!dir) throw new Error("The session has no add-on folder.");
  if (decision.origin === "new") scaffoldProject({ dir, template: decision.template });
  const applied = applyFeature({
    dir,
    feature: decision.feature,
    design: decision.design,
    evidence: session.feasibility?.evidence || "",
    page: session.feasibility?.page || "",
    brief: session.brief
  });
  patchDevelop(out, { implemented: true, addonPath: dir, written: applied.written, files: applied.files });
  print({ ok: true, ...applied, dir }, out);
}

function build() {
  const out = resolveOut();
  const session = readMerged(out);
  if (!session.develop?.implemented) throw new Error("Build is refused until implement has run.");
  setStep(out, "build", "running", "Building", { doing: "Building the add-on" });
  const result = buildProject(session.addon.path);
  if (!result.ok) throw new Error(result.error || "Build failed.");
  patchDevelop(out, { built: true, buildNote: result.note });
  print({ ok: true, ...result }, out);
}

function pack() {
  const out = resolveOut();
  const session = readMerged(out);
  if (!session.develop?.built) throw new Error("Package is refused until the build has run.");
  const result = packageProject(session.addon.path);
  if (!result.ok) throw new Error(result.error || "Package failed.");
  patchDevelop(out, { packaged: true, zip: result.zip, packageVia: result.via });
  print({ ok: true, ...result }, out);
}

async function audit() {
  const out = resolveOut();
  const session = readMerged(out);
  const project = session.addon.path;
  if (!project) throw new Error("No add-on folder.");
  const reviewOut = path.join(out, "review");
  fs.rmSync(reviewOut, { recursive: true, force: true });
  const review = spawnSync(process.execPath, [path.join(reviewScripts, "review.mjs"), "--input", project, "--no-refresh", "--out", reviewOut], {
    encoding: "utf8",
    env: { ...process.env, EXPRESS_REVIEW_NO_OPEN: "1" }
  });
  if (!fs.existsSync(path.join(reviewOut, "session.json"))) {
    throw new Error(review.stderr || review.stdout || "Add-on Review did not start a session.");
  }
  const source = builtDir(project);
  if (!source) throw new Error("No index.html to serve for the audit.");
  const served = await serveWithStandIn(source);
  let auditJson = {};
  try {
    const ran = spawnSync(process.execPath, [path.join(reviewScripts, "audit.mjs"), "--out", reviewOut, "--url", served.url], {
      encoding: "utf8",
      timeout: 240000,
      env: { ...process.env, EXPRESS_REVIEW_NO_OPEN: "1" }
    });
    const line = (ran.stdout || "").split("\n").map((item) => item.trim()).filter((item) => item.startsWith("{")).at(-1) || "{}";
    try {
      auditJson = JSON.parse(line);
    } catch {
      auditJson = { ok: false, error: (ran.stderr || ran.stdout || "audit produced no JSON").slice(-1000) };
    }
    if (ran.error) auditJson.error = ran.error.message;
  } finally {
    await served.close();
  }
  const bugs = auditJson.bugs || [];
  patchDevelop(out, {
    audited: true,
    auditOk: bugs.length === 0 && auditJson.ok !== false,
    auditBugs: bugs,
    standIn: served.label,
    expressPass: false,
    reviewOut
  });
  fs.writeFileSync(path.join(out, "browser-run.json"), `${JSON.stringify({
    standIn: served.label,
    expressPass: false,
    url: served.url,
    note: "Headless Chrome served the built panel with an SDK stand-in. This is not an Adobe Express pass.",
    audit: auditJson
  }, null, 2)}\n`);
  print({
    ok: bugs.length === 0 && auditJson.ok !== false,
    bugs,
    screens: auditJson.screens || 0,
    warnings: auditJson.warnings || 0,
    standIn: served.label,
    expressPass: false,
    reviewOut,
    reviewStatus: review.status
  }, out);
}

function listingText() {
  const out = resolveOut();
  const session = readMerged(out);
  const dir = session.addon.path;
  const manifestPath = fs.existsSync(path.join(dir, "src", "manifest.json")) ? path.join(dir, "src", "manifest.json") : path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let description = "";
  try {
    description = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).description || "";
  } catch {
    description = "";
  }
  const listing = {
    name: manifest.name || session.addon.name,
    summary: description || session.brief || manifest.name,
    description: description || session.brief || "",
    keywords: []
  };
  setListing(out, listing);
  print({ ok: true, listing }, out);
}

function resolveOut() {
  if (args.out) return path.resolve(args.out);
  if (process.env.EXPRESS_DEVELOP_OUT) return path.resolve(process.env.EXPRESS_DEVELOP_OUT);
  if (process.env.EXPRESS_REVIEW_OUT) return path.resolve(process.env.EXPRESS_REVIEW_OUT);
  const remembered = rememberedOut();
  if (remembered) return remembered;
  throw new Error("No develop folder. Run develop.mjs begin, or pass --out.");
}

function print(value, out) {
  const body = { ...value };
  if (out && body.next === undefined && body.ok !== false) body.next = reminder(out);
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function usage() {
  process.stdout.write("Usage: develop.mjs begin|docs|templates|classify|implement|build|package|audit|listing-text\n");
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    parsed[token.slice(2)] = argv[i + 1];
    i += 1;
  }
  return parsed;
}
