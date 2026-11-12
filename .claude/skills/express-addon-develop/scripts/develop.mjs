#!/usr/bin/env node
/**
 * Express Add-on Develop Assistant.
 *
 *   begin --dir <folder> --goal "<request, word for word>" [--name <name>] [--brief "<feature>"] [--out dir]
 *   refresh-plan
 *   apply-tweak
 *   docs [--budget 20000] [--page-timeout 8000]
 *   templates
 *   classify
 *   implement
 *   record
 *   build
 *   package
 *   audit
 *   feedback [--changed "..."] [--skip]
 *   listing-text
 *
 * `begin` does not use the network. Mode, then planning, then the confirm card, before docs.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reminder } from "../../express-addon-review/scripts/lib/next.mjs";
import { addShot, mutate, publishAsk, readMerged, setListing } from "../../express-addon-review/scripts/lib/session.mjs";
import { resolveDevelopPlan } from "./lib/flow.mjs";
import { prepareFeedback } from "./lib/feedback.mjs";
import { fetchDevDocs, pagesForBrief } from "./lib/docs-live.mjs";
import { fetchSpectrumCatalog, readSpectrumCatalog, writeSpectrumCatalog } from "./lib/spectrum-catalog.mjs";
import { classifyFeature, pagesFromDisk } from "./lib/feasibility.mjs";
import { applyManifestName, gate, implementationHandoff, scaffoldProject, scrubTemplateChrome, verifyFeature } from "./lib/implement.mjs";
import { deriveName, isBlankGoal } from "./lib/intent.mjs";
import { fillListingDir, listingFrom } from "./lib/listing-copy.mjs";
import { applyPlanning, parseTweak, planAsk } from "./lib/planning.mjs";
import { setAddonVersion } from "./lib/version.mjs";
import { buildProject, packageProject } from "./lib/package-addon.mjs";
import { homeDir, liveDir, rememberedOut, rememberOut, reviewScripts } from "./lib/paths.mjs";
import { patchDevelop, refreshPlanCard, saveDocs, saveFeasibility, saveTemplates, setStep, startDevelopSession } from "./lib/session-start.mjs";
import { builtDir, serveWithStandIn } from "./lib/standin.mjs";
import { fetchTemplates } from "./lib/templates.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

try {
  if (command === "begin") begin();
  else if (command === "refresh-plan") refreshPlan();
  else if (command === "apply-tweak") applyTweak();
  else if (command === "docs") await docs();
  else if (command === "templates") await templates();
  else if (command === "classify") classify();
  else if (command === "implement") implement();
  else if (command === "record") record();
  else if (command === "build") build();
  else if (command === "package") pack();
  else if (command === "audit") await audit();
  else if (command === "feedback") await feedback();
  else if (command === "listing-text") listingText();
  else if (command === "listing-shots") listingShots();
  else if (command === "version") version();
  else usage();
  process.exit(0);
} catch (error) {
  let next = "Run `node scripts/session.mjs next` and do what it says. Do not end your turn.";
  if (/not an empty folder|Nothing was deleted/.test(error.message || "")) {
    next = "Stopped. No session was created, and nothing was deleted. Do not run session.mjs next.";
  } else if (/The feature is not done/.test(error.message || "")) {
    next = "Record failed. Fix the feature and run `node scripts/develop.mjs record` again. Do not end your turn.";
  } else {
    try {
      const out = resolveOut();
      next = reminder(out, { dashboardUp: dashboardUp(out) });
    } catch {
      // No session yet. The sentence above is still a next line.
    }
  }
  process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, next })}\n`);
  process.exit(1);
}

function begin() {
  if (!args.dir) throw new Error("Use --dir for the empty folder or the existing add-on.");
  const dir = path.resolve(args.dir);
  const goal = typeof args.goal === "string" ? args.goal.trim() : "";
  const brief = typeof args.brief === "string" ? args.brief.trim() : "";
  const job = goal || brief;
  const named = typeof args.name === "string" ? args.name.trim() : "";
  let out = path.resolve(args.out || path.join(homeDir(), slugFrom(named || deriveName(job) || path.basename(dir))));
  const facts = inspectFolder(dir);
  if (args.empty && !facts.empty) {
    throw new Error(`${dir} is not an empty folder. --empty was not applied, and nothing in the folder was deleted.`);
  }
  if (!args.fresh && sameSession(out, dir) && !sessionIsFinished(out)) {
    rememberOut(out);
    print({
      ok: true,
      out,
      resumed: true,
      network: false,
      next: "The session is already open for this folder. Nothing was deleted. Run `node scripts/session.mjs next` and do what it says. Do not end your turn."
    }, null);
    return;
  }
  if (sameSession(out, dir) && sessionIsFinished(out)) {
    const slug = slugFrom(named || deriveName(job) || path.basename(dir));
    out = path.join(homeDir(), "sessions", `${slug}-${Date.now().toString(36)}`);
  }
  if (!facts.empty && !facts.manifest) {
    throw new Error(`${dir} is not an empty folder and has no add-on manifest. Nothing was deleted. Start from an empty folder, or point --dir at an existing add-on.`);
  }
  if (args.fresh) fs.rmSync(path.join(out, "answers.jsonl"), { force: true });
  const existing = Boolean(facts.manifest) && !args.empty;
  const currentName = existing ? readManifestName(dir) : "";
  const nameIgnored = existing && named && currentName && named !== currentName ? named : "";
  const displayName = currentName || named || (isBlankGoal(job) ? path.basename(dir) : deriveName(job));
  startDevelopSession(out, { name: displayName, dir, brief: job, goal: job });
  patchDevelop(out, { empty: Boolean(args.empty) || facts.empty, folder: existing ? "existing" : "empty", ...(nameIgnored ? { nameIgnored } : {}) });
  if (existing) setStep(out, "template", "skipped", "An existing add-on does not get a template");
  const plan = resolveDevelopPlan(readMerged(out));
  print({
    ok: true,
    out,
    network: false,
    empty: Boolean(args.empty) || facts.empty,
    existing,
    plan: { name: plan.name, goal: plan.goal || "(ask)" },
    ...(nameIgnored ? { nameIgnored, note: `--name ${nameIgnored} was not applied. The manifest already says ${currentName}.` } : {}),
    next: "Ask the mode question in questions.json with AskQuestion, then `node scripts/session.mjs mode --set dashboard` or `node scripts/session.mjs mode --set chat`. Do not fetch the docs before mode, planning, and the confirm card. Do not end your turn."
  }, null);
}

function refreshPlan() {
  const out = resolveOut();
  const plan = refreshPlanCard(out);
  print({
    ok: true,
    plan,
    card: planAsk(plan).prompt,
    next: "Ask `plan` next: `node scripts/session.mjs ask --id plan`. Do not end your turn."
  }, out);
}

function applyTweak() {
  const out = resolveOut();
  const session = readMerged(out);
  const tweak = session.asks.find((item) => item.id === "tweak" && item.status === "answered");
  if (!tweak) throw new Error("No tweak answer yet.");
  const plan = resolveDevelopPlan(session);
  const changes = parseTweak(tweak.answer, plan);
  const next = applyPlanning({ ...plan, ...changes }, {});
  if (changes.goal) next.goal = changes.goal;
  if (changes.name) next.name = changes.name;
  if (changes.design) next.designHint = changes.design;
  if (changes.origin) next.origin = changes.origin;
  patchDevelop(out, {
    tweakApplied: tweak.answer,
    brief: next.goal,
    name: next.name,
    description: next.description || "",
    features: next.features || {},
    designHint: next.designHint || "",
    ...(changes.origin === "existing" || changes.origin === "new" ? { folder: changes.origin === "existing" ? "existing" : "empty" } : {})
  });
  mutate(out, (draft) => {
    draft.asks = draft.asks.filter((item) => item.id !== "plan" && item.id !== "tweak");
    draft.brief = next.goal;
    draft.addon.name = next.name;
    draft.develop = { ...(draft.develop || {}), planCardFresh: false, tweakApplied: tweak.answer };
    if (draft.steps.find((step) => step.id === "plan")) {
      const step = draft.steps.find((item) => item.id === "plan");
      step.status = "pending";
      step.detail = "";
      step.endedAt = null;
    }
  });
  refreshPlanCard(out);
  print({ ok: true, plan: next, next: "Ask `plan` again with the updated spec. Do not end your turn." }, out);
}

async function feedback() {
  const out = resolveOut();
  const prepared = await prepareFeedback(out, { changed: typeof args.changed === "string" ? args.changed : "", skip: Boolean(args.skip) });
  if (prepared.skipped) {
    print({ ok: true, ...prepared, next: "Run `node scripts/session.mjs next` and do what it says." }, out);
    return;
  }
  if (!prepared.ok) {
    print({ ok: false, error: prepared.error, next: prepared.next }, out);
    process.exitCode = 1;
    return;
  }
  if (prepared.already || prepared.answered) {
    print({ ok: true, ...prepared }, out);
    return;
  }
  publishAsk(out, prepared.definition);
  const session = readMerged(out);
  const channel = session.mode === "dashboard" ? "dashboard" : "chat";
  if (prepared.publish === "serve") {
    const wait = channel === "dashboard"
      ? "The start question is on the dashboard. Do NOT write to the user. Run `node scripts/session.mjs wait --id serve` now."
      : "Ask the serve question with AskQuestion (Start it for me, or I'll start it myself). Then `node scripts/session.mjs answer --id serve --value start|manual`. Do not run npm start yourself before they answer.";
    print({ ok: true, id: "serve", publish: "serve", channel, next: wait }, out);
    return;
  }
  if (channel === "dashboard") {
    print({
      ok: true,
      id: "feedback",
      round: prepared.round,
      channel,
      next: "The try card is on the dashboard. Do NOT write to the user. Run `node scripts/session.mjs wait --id feedback` now."
    }, out);
    return;
  }
  print({
    ok: true,
    id: "feedback",
    round: prepared.round,
    channel,
    next: "Ask the feedback question with AskQuestion (include the prompt and options). For bugs, pass --text and optional --image when recording: `node scripts/session.mjs answer --id feedback --value bugs --text \"...\"`. For no more bugs: `--value good`."
  }, out);
}

function sameSession(out, dir) {
  try {
    const session = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
    return session.kind === "develop" && path.resolve(session.addon?.path || "") === dir;
  } catch {
    return false;
  }
}

function sessionIsFinished(out) {
  try {
    const session = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
    return session.steps?.find((step) => step.id === "done")?.status === "done";
  } catch {
    return false;
  }
}

function inspectFolder(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name !== ".gitkeep" && name !== ".git");
  } catch {
    names = [];
  }
  const manifest = fs.existsSync(path.join(dir, "manifest.json")) || fs.existsSync(path.join(dir, "src", "manifest.json"));
  return { empty: names.length === 0, manifest };
}

async function docs() {
  const out = resolveOut();
  const session = readMerged(out);
  if (!session?.mode) throw new Error("Set mode before fetching. Mode comes first, and this command is the network.");
  setStep(out, "docs", "running", "Fetching Adobe docs", { doing: "Fetching Adobe docs" });
  const writeCache = process.env.EXPRESS_DEVELOP_WRITE_CACHE === "1";
  const result = await fetchDevDocs({
    budgetMs: Number(args.budget) || 20000,
    pageMs: Number(args["page-timeout"]) || 8000,
    cacheDir: liveDir,
    destDir: path.join(out, "docs"),
    pages: pagesForBrief(session.brief)
  });
  saveDocs(out, result);
  setStep(out, "docs", "running", "Fetching the Spectrum catalog", { doing: "Fetching the Spectrum component catalog" });
  const spectrumDir = path.join(out, "docs", "spectrum");
  const spectrum = await fetchSpectrumCatalog();
  const written = spectrum.ok ? writeSpectrumCatalog(spectrumDir, spectrum) : null;
  patchDevelop(out, {
    spectrumCatalog: {
      ok: spectrum.ok,
      version: spectrum.version,
      count: spectrum.components.length,
      file: written?.markdown || "",
      failed: spectrum.failed.length,
      error: spectrum.error || ""
    }
  });
  if (writeCache) {
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
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  const counts = result.counts;
  if ((counts.failed || 0) > 0 && !(counts.fresh || 0) && !(counts.stale || 0)) {
    patchDevelop(out, { docsBlocked: "Every Adobe doc page failed." });
  }
  setStep(out, "docs", "done", `${counts.fresh} fresh, ${counts.stale} stale, ${counts.failed} failed`);
  print({ ok: true, ...result }, out);
}

async function templates() {
  const out = resolveOut();
  const session = readMerged(out);
  const tooling = path.join(out, "docs", "src/pages/guides/getting-started/local-development/dev-tooling.md");
  const pageText = fs.existsSync(tooling) ? fs.readFileSync(tooling, "utf8") : "";
  const design = (session.asks || []).find((item) => item.id === "design" && item.status === "answered")?.answer || "";
  setStep(out, "template", "running", "Fetching templates", { doing: "Fetching Adobe's template list" });
  const result = await fetchTemplates({ pageText });
  const stored = { ...result };
  delete stored.raw;
  saveTemplates(out, stored, design);
  fs.writeFileSync(path.join(out, "templates.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    patchDevelop(out, { templatesFailed: result.note || "The template list could not be fetched." });
    print({
      ok: false,
      error: result.note,
      stopped: true,
      next: "Stopped. The template names could not be fetched, so the build does not continue. Do not run templates again, and do not say the next step is picking a template.",
      ...stored
    }, out);
    process.exit(1);
  }
  print({ ok: true, ids: result.ids, source: result.source, npmVersion: result.npmVersion, note: result.note }, out);
  void session;
}

function classify() {
  const out = resolveOut();
  const session = readMerged(out);
  setStep(out, "implement", "running", "Reading the docs", { doing: "Checking this against Adobe's docs" });
  const pages = pagesFromDisk(out, session.docs);
  const feasibility = classifyFeature(session.brief, pages);
  saveFeasibility(out, feasibility);
  print({ ok: Boolean(feasibility.class), ...feasibility }, out);
}

function implement() {
  const out = resolveOut();
  const session = readMerged(out);
  setStep(out, "implement", "running", "Writing the add-on", { doing: "Writing the add-on" });
  const decision = gate(session);
  if (!decision.ok) throw new Error(decision.error);
  const dir = session.addon.path;
  if (!dir) throw new Error("The session has no add-on folder.");
  const already = fs.existsSync(path.join(dir, "src", "manifest.json")) || fs.existsSync(path.join(dir, "manifest.json"));
  if (decision.origin === "new" && !already) {
    try {
      scaffoldProject({ dir, template: decision.template });
    } catch (error) {
      if (/is not an empty folder/.test(error.message)) patchDevelop(out, { blockedEmpty: true });
      throw error;
    }
  }
  const existingAddon = session.develop?.folder === "existing";
  if (!existingAddon) {
    applyManifestName(dir, session.addon?.name);
    scrubTemplateChrome(dir, session.addon?.name);
  }
  else patchDevelop(out, { nameLeft: readManifestName(dir) });
  const pages = (session.docs?.pages || [])
    .filter((page) => /architecture|document-api|implementation-guide|use-text|position-elements|resize-elements|use-images|oauth2|create-renditions/.test(page.id || ""))
    .map((page) => ({ id: page.id, label: page.label, url: page.url }));
  const catalog = readSpectrumCatalog(path.join(out, "docs", "spectrum", "catalog.json"));
  const handoff = implementationHandoff({
    brief: session.brief,
    pages,
    design: decision.design,
    catalog: catalog ? { version: catalog.version, components: catalog.components, file: path.join(out, "docs", "spectrum", "catalog.json"), markdown: path.join(out, "docs", "spectrum", "catalog.md") } : null
  });
  if (!session.develop?.implemented) patchDevelop(out, { handoff, implemented: false, addonPath: dir });
  else patchDevelop(out, { handoff, addonPath: dir });
  print({ ok: true, action: "awaiting-agent-implementation", ...handoff, dir }, out);
}

function record() {
  const out = resolveOut();
  const session = readMerged(out);
  const dir = session.addon?.path;
  if (!dir) throw new Error("The session has no add-on folder.");
  const design = session.asks?.find((item) => item.id === "design" && item.status === "answered")?.answer || "";
  const catalog = readSpectrumCatalog(path.join(out, "docs", "spectrum", "catalog.json"));
  const result = verifyFeature({ dir, brief: session.brief, design, catalogTags: catalog?.tags || null });
  if (!result.ok) {
    patchDevelop(out, { implemented: false, verify: result });
    throw new Error(`The feature is not done. ${result.problems.join(" ")}`);
  }
  const files = sourceList(dir);
  patchDevelop(out, { implemented: true, verify: { ok: true, needs: result.needs }, files, addonPath: dir });
  setStep(out, "implement", "done", "Feature verified against the brief");
  print({ ok: true, verified: true, needs: result.needs, files, dir }, out);
}

function build() {
  const out = resolveOut();
  const session = readMerged(out);
  if (!session.develop?.implemented) throw new Error("Build is refused until implement has run.");
  setStep(out, "build", "running", "Building", { doing: "Building the add-on" });
  const result = buildProject(session.addon.path);
  if (!result.ok) throw new Error(result.error || "Build failed.");
  patchDevelop(out, { built: true, buildNote: result.note });
  setStep(out, "build", "done", result.note || "Build finished");
  print({ ok: true, ...result }, out);
}

function pack() {
  const out = resolveOut();
  const session = readMerged(out);
  if (!session.develop?.built) throw new Error("Package is refused until the build has run.");
  setStep(out, "package", "running", "Packaging", { doing: "Packaging the add-on" });
  const result = packageProject(session.addon.path);
  if (!result.ok) throw new Error(result.error || "Package failed.");
  patchDevelop(out, { packaged: true, zip: result.zip, packageVia: result.via });
  setStep(out, "package", "done", "Package written");
  print({ ok: true, ...result }, out);
}

async function audit() {
  const out = resolveOut();
  const session = readMerged(out);
  const project = session.addon.path;
  if (!project) throw new Error("No add-on folder.");
  setStep(out, "audit", "running", "Checking the panel", { doing: "Walking the panel" });
  if (process.env.SKIP_BROWSER_TESTS) {
    const record = browserRun({
      standIn: "express-sdk-stand-in",
      screens: 0,
      note: "The box runner does not start Chrome or Edge. The panel was not walked and nothing was captured."
    });
    patchDevelop(out, { audited: true, auditSkipped: true, auditBugs: [], standIn: record.standIn, expressPass: false, rendered: false });
    fs.writeFileSync(path.join(out, "browser-run.json"), `${JSON.stringify(record, null, 2)}\n`);
    setStep(out, "audit", "done", "Browser walk skipped");
    print({ ok: true, skipped: true, ...record }, out);
    return;
  }
  const reviewOut = path.join(out, "review");
  const staging = path.join(out, "review-next");
  fs.rmSync(staging, { recursive: true, force: true });
  const review = spawnSync(process.execPath, [path.join(reviewScripts, "review.mjs"), "--input", project, "--no-refresh", "--out", staging], {
    encoding: "utf8",
    env: { ...process.env, EXPRESS_REVIEW_NO_OPEN: "1" }
  });
  if (!fs.existsSync(path.join(staging, "session.json"))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(review.stderr || review.stdout || "Add-on Review did not start a session.");
  }
  const source = builtDir(project);
  if (!source) throw new Error("No index.html to serve for the audit.");
  const served = await serveWithStandIn(source);
  let auditJson = {};
  try {
    const ran = await runChild(path.join(reviewScripts, "audit.mjs"), ["--out", staging, "--url", served.url], {
      env: { ...process.env, EXPRESS_REVIEW_NO_OPEN: "1" },
      timeout: 240000
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
  fs.rmSync(reviewOut, { recursive: true, force: true });
  fs.renameSync(staging, reviewOut);
  const bugs = auditJson.bugs || [];
  const screens = auditJson.screens || 0;
  const captures = copyPanelCaptures(out, reviewOut);
  const failed = bugs.length > 0 || auditJson.ok === false;
  const record = browserRun({
    standIn: served.label,
    screens,
    url: served.url,
    note: "Headless Chrome served the built panel with an SDK stand-in. This is not an Adobe Express pass.",
    audit: auditJson,
    rendered: Boolean(auditJson.rendered)
  });
  patchDevelop(out, {
    audited: true,
    auditOk: !failed,
    auditBugs: bugs,
    auditScreens: screens,
    panelCaptures: captures,
    standIn: served.label,
    expressPass: false,
    rendered: Boolean(auditJson.rendered),
    reviewOut
  });
  fs.writeFileSync(path.join(out, "browser-run.json"), `${JSON.stringify(record, null, 2)}\n`);
  setStep(out, "audit", "done", failed ? `Audit failed: ${bugs.length} error${bugs.length === 1 ? "" : "s"}` : screens ? `Walked ${screens} screens with the stand-in` : "Audit finished");
  print({
    ok: !failed,
    bugs,
    screens,
    warnings: auditJson.warnings || 0,
    ...record,
    reviewOut,
    reviewStatus: review.status
  }, out);
}

function browserRun({ standIn, screens, url, note, audit, rendered = false }) {
  return {
    standIn,
    expressPass: false,
    rendered: Boolean(rendered),
    headlessScreens: screens,
    capturedOn: screens > 0 ? "this computer" : "not captured",
    ...(url ? { url } : {}),
    note,
    ...(audit ? { audit } : {})
  };
}

function listingShots() {
  const out = resolveOut();
  const session = readMerged(out);
  const reason = process.env.SKIP_BROWSER_TESTS
    ? "The box runner does not start Chrome or Edge."
    : "";
  if (reason) {
    patchDevelop(out, { listingShots: "failed", listingShotsReason: reason });
    print({
      ok: false,
      skipped: true,
      done: false,
      rendered: false,
      capturedOn: "not captured",
      expressPass: false,
      reason,
      note: "No screenshot was written, and none was claimed. The listing step is not done."
    }, out);
    return;
  }
  const listingDir = path.join(out, "listing");
  const prepared = spawnSync(process.execPath, [path.join(reviewScripts, "prepare-listing.mjs"), "--out", listingDir], { encoding: "utf8" });
  if (prepared.status !== 0) throw new Error(prepared.stderr || prepared.stdout || "prepare-listing failed.");
  // Real pictures of the built panel, taken in headless Chrome. No drawn panel stands in for them.
  const shotsDir = path.join(listingDir, "panel-capture");
  const captured = spawnSync(process.execPath, [path.join(here, "lib", "panel-capture.mjs"), "--dir", session.addon.path, "--out", shotsDir], { encoding: "utf8", timeout: 90000 });
  let capture = {};
  try {
    capture = JSON.parse((captured.stdout || "").trim().split("\n").at(-1) || "{}");
  } catch {
    capture = { ok: false, error: (captured.stderr || "The panel capture produced no result.").trim().slice(-500) };
  }
  if (captured.error?.code === "ETIMEDOUT") capture = { ok: false, error: "Chrome did not finish the panel pictures in 90 seconds." };
  const filled = fillListingDir(listingDir, session.addon.path, { shotsDir: capture.ok ? shotsDir : "", shotsError: capture.ok ? "" : capture.error });
  fs.rmSync(shotsDir, { recursive: true, force: true });
  if (!filled.ok) {
    patchDevelop(out, { listingShots: "failed", listingShotsReason: filled.error });
    print({ ok: false, skipped: true, done: false, rendered: false, capturedOn: "not captured", expressPass: false, reason: filled.error }, out);
    return;
  }
  const rendered = spawnSync(process.execPath, [path.join(reviewScripts, "render-listing.mjs"), "--dir", listingDir, "--input", session.addon.path], {
    encoding: "utf8",
    timeout: 90000
  });
  if (rendered.error?.code === "ETIMEDOUT" || rendered.status !== 0) {
    const why = rendered.error?.code === "ETIMEDOUT"
      ? "Chrome did not finish the listing screenshots, so it cannot run here."
      : (rendered.stderr || rendered.stdout || "Listing screenshots were not rendered.").trim().slice(-2000);
    patchDevelop(out, { listingShots: "failed", listingShotsReason: why });
    print({ ok: false, skipped: true, done: false, rendered: false, capturedOn: "not captured", expressPass: false, reason: why }, out);
    return;
  }
  const finalDir = path.join(listingDir, "final");
  const written = [];
  if (fs.existsSync(finalDir)) {
    for (const name of fs.readdirSync(finalDir).filter((item) => item.endsWith(".png"))) {
      written.push(addShot(out, { file: path.join(finalDir, name), label: name, kind: "listing" }).shot.file);
    }
  }
  if (!written.length) {
    patchDevelop(out, { listingShots: "failed", listingShotsReason: "The renderer wrote no PNG.", listingShotFiles: [] });
    print({ ok: false, done: false, rendered: false, files: [], capturedOn: "not captured", expressPass: false, reason: "The renderer wrote no PNG." }, out);
    return;
  }
  patchDevelop(out, { listingShots: "written", listingShotFiles: written });
  print({
    ok: true,
    done: true,
    files: written,
    rendered: true,
    capturedOn: "this computer",
    expressPass: false
  }, out);
}

function version() {
  let dir = args.dir ? path.resolve(args.dir) : "";
  let out = "";
  if (!dir) {
    out = resolveOut();
    dir = readMerged(out).addon.path;
  }
  const result = setAddonVersion(dir, { set: args.set || "", bump: args.bump || "" });
  if (out && result.changed) patchDevelop(out, { version: result.version });
  print(result, out);
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
  const name = manifest.name || session.addon.name;
  const listing = listingFrom({ name, brief: session.brief, description, dir });
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
  if (body.next === undefined) {
    body.next = out
      ? reminder(out, { dashboardUp: dashboardUp(out) })
      : "Run `node scripts/session.mjs next` and do what it says. Do not end your turn.";
  }
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function dashboardUp(out) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(out, "server.json"), "utf8"));
    if (!info?.pid) return false;
    process.kill(info.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readManifestName(dir) {
  for (const rel of ["src/manifest.json", "manifest.json"]) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8")).name || "";
    } catch {
      // The other path may hold the manifest.
    }
  }
  return "";
}

function runChild(file, args, { env, timeout = 240000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr, error });
    });
  });
}

function slugFrom(name) {
  return String(name || "addon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "addon";
}

function sourceList(dir) {
  const found = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html?|jsx?|tsx?|mjs|json)$/i.test(entry.name)) found.push(path.relative(dir, full));
    }
  };
  try {
    walk(dir);
  } catch {
    return [];
  }
  return found;
}

function copyPanelCaptures(out, reviewOut) {
  let shots = [];
  try {
    shots = JSON.parse(fs.readFileSync(path.join(reviewOut, "session.json"), "utf8")).shots || [];
  } catch {
    return 0;
  }
  let count = 0;
  for (const shot of shots) {
    if (shot.kind && shot.kind !== "panel") continue;
    const file = path.resolve(reviewOut, shot.file || "");
    if (!file || !fs.existsSync(file)) continue;
    try {
      addShot(out, { file, label: shot.label || "Panel", kind: "panel", theme: shot.theme || "" });
      count += 1;
    } catch {
      // A shot that is not an image is not a capture.
    }
  }
  return count;
}

function usage() {
  process.stdout.write("Usage: develop.mjs begin|docs|templates|classify|implement|record|build|package|audit|listing-text|listing-shots|version [--set X.Y.Z | --bump patch|minor|major] [--dir add-on]\n");
  process.exit(1);
}

function parseArgs(argv) {
  const flags = new Set(["empty", "fresh", "skip"]);
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (flags.has(key) && (next === undefined || String(next).startsWith("--"))) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}
