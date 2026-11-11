/**
 * Develop-session steps and the `next` decision.
 * A review session never reaches this. Skip on the BETA Express step goes straight to listing.
 *
 * Order mirrors UXP Assistant: mode → planning gaps → confirm the spec → docs → …
 * → audit → try/feedback → optional Express beta → listing.
 */
import fs from "node:fs";
import path from "node:path";
import { briefNeeds } from "./implement.mjs";
import { loopbackPolicyReason } from "./loopback.mjs";
import { applyPlanning, planAsk, planningQuestions, tweakAsk } from "./planning.mjs";

export const DEVELOP_STEPS = [
  { id: "planning", label: "Planning", hint: "The questions the request did not answer." },
  { id: "plan", label: "Plan", hint: "Confirm the spec, then the build starts." },
  { id: "docs", label: "Fetch the Adobe docs", hint: "Live pages, in parallel, with a time budget. Each page is fresh, stale, or failed." },
  { id: "design", label: "Design for Express", hint: "Spectrum Web Components, unless you want to keep plain controls." },
  { id: "template", label: "Pick a template", optional: true, hint: "Names come from Adobe's CLI this session. The recommended one can edit the Express document." },
  { id: "implement", label: "Write the add-on", hint: "The assistant writes the feature. The dashboard stays on this step while it does." },
  { id: "build", label: "Build", hint: "The add-on's own build." },
  { id: "package", label: "Package", hint: "A zip with the manifest at its root." },
  { id: "audit", label: "Run Add-on Review", hint: "The cloned audit at 320px in light and dark. A browser run is not an Express pass." },
  { id: "try", label: "Try it", hint: "You load it and send what is wrong, with words and screenshots. The assistant fixes it until you say no more bugs." },
  { id: "express", label: "BETA: real Express", optional: true, hint: "Optional. Skip is the default. A pass is only a panel that rendered in Express with the feature exercised. Remote machines skip." },
  { id: "listing", label: "Listing and screenshots", hint: "Text and screenshots are shown before anything is written into the add-on." },
  { id: "done", label: "Wrap up" }
];

const OPEN = new Set(["pending", "running", "waiting"]);
const PLANNING_IDS = new Set(["goal", "name", "description", "feat-layout", "feat-token"]);

/** Build the question list for a new session from the current plan. */
export function initialQuestions(plan = {}) {
  return [
    modeAsk(),
    ...planningQuestions(plan),
    planAsk(plan),
    tweakAsk(),
    designAsk(),
    expressAsk(),
    listingAsk()
  ];
}

export function modeAsk() {
  return {
    id: "mode",
    title: "How to follow this build",
    prompt: "How do you want to follow this build? The dashboard opens in Chrome on this computer and takes every later decision. Chat keeps the decisions in this conversation.",
    options: [
      { id: "dashboard", label: "Live dashboard in Chrome (Recommended)", detail: "Opens a page on this computer only. Progress and every later decision are there." },
      { id: "chat", label: "Stay in chat", detail: "No page opens. Decisions stay in this conversation." }
    ]
  };
}

export function originAsk() {
  return {
    id: "origin",
    title: "Where to start",
    prompt: "Start from an empty folder, or extend an add-on that is already on disk?",
    options: [
      { id: "new", label: "Start from an empty folder (Recommended)", detail: "A template is copied only after feasibility, design, and the write decision." },
      { id: "existing", label: "Extend an add-on I already have", detail: "Uses the folder passed to begin. No template is copied." }
    ]
  };
}

export function designAsk() {
  return {
    id: "design",
    title: "Design",
    prompt: "The implementation guide prefers Spectrum Web Components for Express add-on UI, with the Express theme. Apply that when the fetched guide still says so?",
    options: [
      { id: "swc", label: "Use Spectrum Web Components (Recommended)", detail: "Follows the fetched implementation guide. A template that has no webpack is not rewritten into one in the same step." },
      { id: "leave", label: "Keep the template's controls", detail: "No component library is added." }
    ]
  };
}

export function expressAsk() {
  return {
    id: "express",
    title: "BETA: real Express",
    prompt: "Run a real test in Adobe Express (beta)? Skip is the default. On this computer it trusts the dev certificate, serves https://localhost:5241, and opens Express for you to sign in. A cloud agent, SSH session, or container skips it. The skill never takes a password. A headless audit is not this test.",
    options: [
      { id: "skip", label: "Skip the real Express test (Recommended)", detail: "Does not open Adobe Express. The next step is the listing and the screenshots." },
      { id: "run", label: "Run the real Express test (beta)", detail: "Trusts the dev CA, starts https://localhost:5241, and opens a visible browser at https://new.express.adobe.com. You sign in. Chrome flags stay as they are." }
    ]
  };
}

export function expressResultAsk() {
  return {
    id: "express-result",
    title: "BETA: what happened in Express",
    prompt: "Did the add-on panel render inside Adobe Express, and did you exercise the feature? Sign-in is yours. This skill never takes credentials. Leave chrome://flags/#local-network-access-check enabled and click Allow. Connect Add-on testing to https://localhost:5241 (not 127.0.0.1), then launch from In development. A failure or a timeout is recorded as that.",
    options: [
      { id: "skip", label: "Stop this beta check (Recommended)", detail: "Does not count as an Express pass. The listing is next." },
      { id: "rendered", label: "The panel rendered and I exercised the feature", detail: "Counts as a real Express pass only together with a screenshot of that panel." },
      { id: "failed", label: "It failed or timed out", detail: "Recorded as a failure. Not a pass." }
    ]
  };
}

export function listingAsk() {
  return {
    id: "listing",
    title: "Listing and screenshots",
    prompt: "Write the marketplace listing? The text is drafted from the manifest and the panel, and the screenshots use the locked Preflight template. Nothing is submitted.",
    options: [
      { id: "both", label: "Write the listing text and the screenshots (Recommended)", detail: "Drafts the text and builds the screenshots. You approve each before anything is copied into the add-on." },
      { id: "shots", label: "Screenshots only", detail: "Builds the screenshots for approval." },
      { id: "text", label: "Listing text only", detail: "Drafts the name, summary, description, and keywords." },
      { id: "skip", label: "Not now", detail: "No listing work." }
    ]
  };
}

/**
 * Pick a fetched template. Document editing is the default, so a sandbox template
 * is recommended first. Spectrum follows the design answer when the person has given one.
 * A name that was not fetched is never recommended.
 */
export function recommendTemplate(ids, brief = "", design = "") {
  const list = Array.isArray(ids) ? ids : [];
  const needs = briefNeeds(brief);
  const wantsSpectrum = design === "swc" || (design !== "leave" && (needs.includes("panel") || /\bspectrum\b|\bswc\b/i.test(String(brief || ""))));
  const prefer = wantsSpectrum
    ? ["swc-javascript-with-document-sandbox", "javascript-with-document-sandbox", "swc-javascript", "javascript"]
    : ["javascript-with-document-sandbox", "swc-javascript-with-document-sandbox", "javascript", "swc-javascript"];
  const id = prefer.find((item) => list.includes(item)) || list[0] || "";
  const editsDocument = /document-sandbox/.test(id);
  const reason = editsDocument
    ? (wantsSpectrum && id.startsWith("swc")
      ? "Recommended. Spectrum controls, and this template includes the document sandbox so it can edit the Express document."
      : "Recommended. This template includes the document sandbox so it can edit the Express document.")
    : "Fetched from the CLI package. This one does not include the document sandbox.";
  return { id, reason };
}

export function templateAsk(ids, brief = "", design = "") {
  const recommended = recommendTemplate(ids, brief, design);
  const ordered = recommended.id ? [recommended.id, ...ids.filter((id) => id !== recommended.id)] : ids;
  const options = ordered.map((id) => ({
    id,
    label: id === recommended.id ? `${id} (Recommended)` : id,
    detail: id === recommended.id ? recommended.reason : "Fetched from the CLI package. Not a remembered list."
  }));
  return {
    id: "template",
    title: "Template",
    prompt: `Which template should the empty folder use? ${ids.length} names were fetched from @adobe/create-ccweb-add-on. The copy happens only after you approve the write.`,
    options
  };
}

export function feasibilityAsk(result) {
  const order = ["iframe", "sandbox", "unsupported"];
  const recommended = order.includes(result.class) ? result.class : "unsupported";
  const detail = {
    iframe: "The panel UI runs in the iframe. The evidence sentence is on the architecture page.",
    sandbox: "Document APIs are not available in the iframe. The evidence sentence is on the architecture page.",
    unsupported: "The fetched pages do not support this feature. Nothing is written for it."
  };
  const label = {
    iframe: "iframe UI",
    sandbox: "Document sandbox APIs",
    unsupported: "Unsupported"
  };
  const options = [recommended, ...order.filter((id) => id !== recommended)].map((id) => ({
    id,
    label: id === recommended ? `${label[id]} (Recommended)` : label[id],
    detail: detail[id]
  }));
  return {
    id: "feasibility",
    title: "Feasibility",
    prompt: result.summary || "Where does this feature run?",
    options
  };
}

/**
 * What to do next in a develop session. It does not write the session.
 * @param {object} session merged session
 * @param {{ dashboardUp?: boolean, out?: string }} options
 */
export function developNext(session, { dashboardUp = false, out = "" } = {}) {
  const steps = session.steps || [];
  const asks = session.asks || [];
  const step = (id) => steps.find((item) => item.id === id);
  const open = (id) => OPEN.has(step(id)?.status);
  const answered = (id) => asks.find((item) => item.id === id && item.status === "answered");
  const published = (id) => asks.some((item) => item.id === id);
  const dashboard = session.mode === "dashboard" && dashboardUp;
  const ask = (id) => dashboard
    ? { action: "ask", ask: id, command: `node scripts/session.mjs ask --id ${id}`, say: `The \`${id}\` question goes on the dashboard. Run ask, then wait. Do not write to the user.` }
    : { action: "ask-in-chat", ask: id, command: `node scripts/session.mjs ask --id ${id}`, say: `Ask \`${id}\` with AskQuestion, then record it with session.mjs answer.` };
  const questions = readQuestionsFile(out);

  if (session.develop?.implemented === false && session.develop?.verify && session.develop.verify.ok === false) {
    return { action: "run", command: "node scripts/develop.mjs record", say: "Record failed. Fix the feature and run `node scripts/develop.mjs record` again." };
  }
  if (step("done")?.status === "done") {
    const expressLine = expressOutcome(session);
    return { action: "finished", say: `The build is finished. Give the user the summary. Run \`node scripts/dashboard.mjs stop\` if the dashboard is still up. ${expressLine} This is not marketplace approval. A new request on this folder starts with \`begin\` again. A finished session does not block that.` };
  }
  if (!session.mode) {
    return { action: "ask-mode", say: "Ask the `mode` question in questions.json with AskQuestion, then `session.mjs mode --set dashboard|chat`. Do not fetch anything before that." };
  }
  if (session.mode === "dashboard" && !dashboardUp) {
    return { action: "start-dashboard", command: "node scripts/dashboard.mjs start", say: "The dashboard is not running. Start it. If it fails, `session.mjs mode --set chat` and continue in chat." };
  }

  const pending = asks.find((item) => item.status === "pending");
  if (pending) {
    return dashboard
      ? { action: "wait", ask: pending.id, command: `node scripts/session.mjs wait --id ${pending.id}`, say: `The question "${pending.title || pending.id}" is on the dashboard. Do not write to the user. Run the wait command now, and run it again while status is pending.` }
      : { action: "ask-in-chat", ask: pending.id, command: `node scripts/session.mjs ask --id ${pending.id}`, say: `Ask "${pending.title || pending.id}" with AskQuestion, then record the click with \`session.mjs answer --id ${pending.id} --value <option id${pending.input === "text" ? " or their words" : ""}>\`.` };
  }

  // An answer that opens another round (a bug report) comes before any later step.
  const again = asks.find((ask) => ask.status === "answered" && ask.options?.find((option) => option.id === ask.answer)?.repeat);
  if (again) {
    const option = again.options.find((item) => item.id === again.answer);
    const words = again.answerText ? ` Their words: "${again.answerText}".` : "";
    const shots = (again.answerImages || []).map((file) => file);
    const seen = shots.length ? ` Screenshots to read: ${shots.join(", ")}.` : "";
    return { action: "apply", ask: again.id, say: `${option.then || "Work on what they sent, then ask again."}${words}${seen}` };
  }

  const ended = asks.find((ask) => ask.status === "answered" && ask.options?.find((option) => option.id === ask.answer)?.ends);
  if (ended) {
    const summary = `Stopped by the user at the ${String(ended.title || ended.id).toLowerCase()} question. Nothing was built.`;
    return { action: "finish", command: `node scripts/session.mjs done --summary "${summary}"`, say: `The user chose to stop. Run done and tell them in one line.` };
  }

  // Planning gaps, then the confirm card — before any network call.
  if (open("planning") || open("plan")) {
    const planEarly = resolveDevelopPlan(session);
    for (const question of questions) {
      if (question.id === "mode") continue;
      if (!whenMet(question.when, session)) continue;
      if (!PLANNING_IDS.has(question.id) && question.id !== "plan" && question.id !== "tweak") continue;
      if (!answered(question.id) && !published(question.id)) {
        if (question.id === "plan" && !session.develop?.planCardFresh) {
          return {
            action: "run",
            command: "node scripts/develop.mjs refresh-plan",
            say: "Refresh the plan card from the planning answers, then ask Confirm the spec."
          };
        }
        return ask(question.id);
      }
    }
    if (answered("plan")?.answer === "change" && !answered("tweak")) return ask("tweak");
    if (answered("plan")?.answer === "change" && answered("tweak") && session.develop?.tweakApplied !== answered("tweak").answer) {
      return { action: "run", command: "node scripts/develop.mjs apply-tweak", say: "Apply the tweak to the plan, then ask Confirm the spec again." };
    }
    if (answered("plan")?.answer === "build") {
      if (open("planning")) {
        return { action: "run", command: "node scripts/session.mjs step --id planning --status done --detail \"Planning answered\"", say: "Mark planning done." };
      }
      if (open("plan")) {
        return { action: "run", command: "node scripts/session.mjs step --id plan --status done --detail \"Spec confirmed\"", say: `Spec confirmed for "${planEarly.name}". Mark the plan done. Docs are next. Do not write project files yet.` };
      }
    }
  }

  if (open("docs")) {
    if (!session.docs) {
      return { action: "run", command: "node scripts/develop.mjs docs", say: "Fetch the Adobe docs now. The dashboard shows fresh, stale, and failed as the pages return." };
    }
    const counts = session.docs.counts || {};
    if (session.develop?.docsBlocked || ((counts.failed || 0) > 0 && !(counts.fresh || 0) && !(counts.stale || 0))) {
      return { action: "finish", command: "node scripts/session.mjs done --summary \"Stopped. The Adobe docs could not be fetched.\"", say: "Every doc page failed. Stop. Do not pick a template." };
    }
    const failed = counts.failed ? ` ${counts.failed} pages failed. Say that before the next question.` : "";
    const stale = counts.stale ? ` ${counts.stale} pages are stale. Say that. It is not a clean fetch.` : "";
    return { action: "run", command: `node scripts/session.mjs step --id docs --status done --detail "${counts.fresh || 0} fresh, ${counts.stale || 0} stale, ${counts.failed || 0} failed"`, say: `The fetch is recorded. Mark the docs step done.${stale}${failed}` };
  }

  if (open("design")) {
    if (!answered("design")) return ask("design");
    return { action: "run", command: "node scripts/session.mjs step --id design --status done --detail \"Design answered\"", say: "Mark design done. The template list is next. Still write nothing." };
  }

  if (open("template")) {
    if (session.develop?.folder === "existing" || answered("origin")?.answer === "existing") {
      return { action: "run", command: "node scripts/session.mjs step --id template --status skipped --detail \"An existing add-on does not get a template\"", say: "Skip the template step. The dashboard should keep showing that work is moving." };
    }
    if (session.develop?.templatesFailed) {
      return { action: "finish", command: "node scripts/session.mjs done --summary \"Stopped. The template list could not be fetched.\"", say: "The template fetch failed. Stop. Do not say the next step is picking a template." };
    }
    if (!session.templates?.ids?.length) {
      return { action: "run", command: "node scripts/develop.mjs templates", say: "Fetch the template names from the CLI package. The dashboard says this is happening. Do not invent a list. If the fetch fails, stop and say so." };
    }
    if (!answered("template")) return ask("template");
    return { action: "run", command: "node scripts/session.mjs step --id template --status done --detail \"Template chosen\"", say: "Mark the template step done. The folder is still empty." };
  }

  if (session.develop?.blockedEmpty && open("implement")) {
    return { action: "finish", command: "node scripts/session.mjs done --summary \"Stopped. The folder was not empty, so nothing was scaffolded.\"", say: "The folder is not empty. Do not run implement again." };
  }

  if (open("implement")) {
    if (answered("plan")?.answer !== "build") {
      return { action: "ask", ask: "plan", command: "node scripts/session.mjs ask --id plan", say: "The spec is not confirmed. Ask the plan card first." };
    }
    if (!session.feasibility) {
      return { action: "run", command: "node scripts/develop.mjs classify", say: "Read the docs for this feature without asking. Document editing stays available. If the pages say the job cannot be done, stop in plain words. Do not ask iframe or document sandbox." };
    }
    if (session.feasibility.class === "unsupported") {
      const why = session.feasibility.summary || "Express cannot do this.";
      return { action: "finish", command: `node scripts/session.mjs done --summary "Stopped. ${why}"`, say: `${why} Stop. Do not ask the developer to choose where it runs.` };
    }
    if (!session.feasibility.class) {
      return { action: "finish", command: "node scripts/session.mjs done --summary \"Stopped. The Adobe docs did not support classifying this feature.\"", say: "The architecture page was missing, so this was not classified. Stop. Do not invent a class." };
    }
    if (!session.develop?.handoff) {
      return { action: "run", command: "node scripts/develop.mjs implement", say: "Scaffold if this is a new folder, then hand the brief, the fetched pages, and the APIs to the agent. Do not write a stub. Do not ask the developer anything." };
    }
    if (!session.develop?.implemented || session.develop?.verify?.ok !== true) {
      const handoff = session.develop.handoff;
      return {
        action: "awaiting-agent-implementation",
        command: "node scripts/develop.mjs record",
        say: "The dashboard already says the add-on is being written. Keep it moving: `node scripts/session.mjs step --id implement --status running --doing \"<what you are writing>\" --progress 2/5`. Write the feature from the brief, the fetched pages, and the APIs below. The add-on includes the document sandbox so it can edit the Express document. Then run record. A stub is rejected.",
        brief: handoff.brief,
        pages: handoff.pages,
        apis: handoff.apis
      };
    }
    return { action: "run", command: "node scripts/session.mjs step --id implement --status done --detail \"Feature verified against the brief\"", say: "The feature was verified. Mark implement done." };
  }

  if (open("build")) {
    if (!session.develop?.built) return { action: "run", command: "node scripts/develop.mjs build", say: "Build the add-on." };
    return { action: "run", command: "node scripts/session.mjs step --id build --status done --detail \"Build finished\"", say: "Mark the build done." };
  }

  if (open("package")) {
    if (!session.develop?.packaged) return { action: "run", command: "node scripts/develop.mjs package", say: "Package the add-on." };
    return { action: "run", command: "node scripts/session.mjs step --id package --status done --detail \"Package written\"", say: "Mark the package done." };
  }

  if (open("audit")) {
    if (!session.develop?.audited) {
      return { action: "run", command: "node scripts/develop.mjs audit", say: "Run Add-on Review's audit. The browser uses an SDK stand-in. That is not an Express pass." };
    }
    const failed = session.develop?.auditOk === false;
    const detail = failed ? "Audit failed" : "Audit finished";
    const say = failed
      ? "The audit failed. Say that in the summary. Do not call it a pass. The BETA Express step is next, and it is optional."
      : "Mark the audit done. The BETA Express step is next, and it is optional.";
    return { action: "run", command: `node scripts/session.mjs step --id audit --status done --detail "${detail}"`, say };
  }

  if (open("try")) {
    if (!answered("feedback") || answered("feedback")?.options?.find((item) => item.id === answered("feedback").answer)?.repeat) {
      return { action: "run", command: "node scripts/develop.mjs feedback", say: "Publish the try card for the developer. Then wait for the answer. If no person is there (a background or cloud run), run it with --skip." };
    }
    if (answered("feedback")?.answer === "good") {
      return { action: "run", command: "node scripts/session.mjs step --id try --status done --detail \"No more bugs\"", say: "The developer said no more bugs. Mark try done. The optional Express beta is next." };
    }
  }

  // Immediately before listing. Skip does not insert another step.
  if (open("express") && !answered("express")) return ask("express");

  if (answered("express")?.answer === "skip" && open("listing") && !published("listing")) {
    return ask("listing");
  }

  if (open("express") && answered("express")?.answer === "skip") {
    return { action: "run", command: "node scripts/session.mjs step --id express --status skipped --detail \"Skipped the real Express test\"", say: "The listing question is already published. Mark the Express step skipped. Express was not opened." };
  }

  if (open("express") && answered("express")?.answer === "run" && !session.develop?.expressChecked) {
    return { action: "run", command: "node scripts/express-run.mjs", say: "Beta real Express. A remote machine skips with a reason. On this computer, trust the dev CA, start https://localhost:5241, and open a visible browser at https://new.express.adobe.com. Do not type credentials. Do not disable Chrome flags. Do not use 127.0.0.1 or ignore-certificate-errors." };
  }

  if (answered("express")?.answer === "run" && (session.develop?.expressRemote || session.develop?.expressBlocked || session.develop?.expressPolicy)) {
    if (open("listing") && !published("listing")) return ask("listing");
    if (open("express")) {
      const why = `${session.develop?.expressReason || ""} ${session.develop?.expressBlocked || ""}`;
      const policy = /LoopbackNetworkBlockedForUrls/.test(why);
      const failed = Boolean(session.develop?.expressBlocked);
      const status = failed ? "done" : "skipped";
      const detail = failed
        ? (policy ? "Failed: Chrome policy LoopbackNetworkBlockedForUrls blocks loopback. Private link: npm run package, dist.zip, Manage add-ons, the listing, Private link. Do not create a publisher profile or a listing." : "Beta check stopped before Express. See express-host.json")
        : (policy ? "Skipped: Chrome policy LoopbackNetworkBlockedForUrls blocks loopback. Private link: npm run package, dist.zip, Manage add-ons, the listing, Private link. Do not create a publisher profile or a listing." : "Remote machine: real Express was not opened");
      const say = failed
        ? (policy
          ? `The beta check failed because ${loopbackPolicyReason()} Express shows a PORT error. No Chrome security flag is added. It is not a pass. The listing is next.`
          : "The beta check failed before Express. It is not a pass. The listing is next.")
        : (policy
          ? `Skipped. ${loopbackPolicyReason()} The listing is next.`
          : "This machine is remote, so the beta Express test was skipped. The listing is next.");
      return { action: "run", command: `node scripts/session.mjs step --id express --status ${status} --detail "${detail}"`, say };
    }
  }

  if (answered("express")?.answer === "run" && session.develop?.expressChecked && !session.develop?.expressRemote && !session.develop?.expressBlocked && !session.develop?.expressPolicy) {
    if (!answered("express-result")) return ask("express-result");
    if (!session.develop?.expressJudged) {
      return { action: "run", command: "node scripts/express-run.mjs --confirm", say: "Record the beta result. A pass needs the panel rendered in Express, the feature exercised, and a screenshot. A failure or a timeout is recorded as that." };
    }
    if (open("listing") && !published("listing")) return ask("listing");
    if (open("express")) {
      const pass = session.develop.expressPass === true;
      const detail = pass ? "Real Express pass: the panel rendered and the feature was exercised" : "Not an Express pass";
      const say = pass
        ? "Mark the beta step done. The panel rendered in Express and the feature was exercised."
        : "Mark the beta step done. This is not an Express pass.";
      return { action: "run", command: `node scripts/session.mjs step --id express --status done --detail "${detail}"`, say };
    }
  }

  if (open("listing")) return listingNext(session, { answered, published, ask });

  const summary = `${expressOutcome(session)} This is not marketplace approval.`;
  return { action: "finish", command: `node scripts/session.mjs done --summary "${summary}"`, say: "Run done, then stop the dashboard. Say whether the beta Express check passed, failed, or was skipped. Do not call it marketplace approval." };
}

function expressOutcome(session) {
  const express = (session.steps || []).find((step) => step.id === "express");
  const audit = session.develop?.auditOk === false ? "The audit failed. " : "";
  let expressLine = "The beta Express check did not pass.";
  if (session.develop?.expressPass === true) expressLine = "The beta Express check passed: the panel rendered and the feature was exercised.";
  else if (express?.status === "skipped") {
    expressLine = /LoopbackNetworkBlockedForUrls/.test(`${session.develop?.expressReason || ""} ${session.develop?.expressBlocked || ""}`)
      ? `The beta Express check was skipped because ${loopbackPolicyReason()}`
      : "The beta Express check was skipped.";
  } else if (/LoopbackNetworkBlockedForUrls/.test(`${session.develop?.expressReason || ""} ${session.develop?.expressBlocked || ""}`)) {
    expressLine = "The beta Express check failed because Chrome policy LoopbackNetworkBlockedForUrls blocks loopback.";
  }
  return `${audit}${expressLine}`;
}

function answerOf(session, id) {
  const ask = (session.asks || []).find((item) => item.id === id && item.status === "answered");
  return ask ? ask.answer : undefined;
}

/** A question with `when: { plan: "change" }` is asked only after that answer. */
export function whenMet(when, session) {
  if (!when) return true;
  return Object.entries(when).every(([id, wanted]) => {
    const got = answerOf(session, id);
    return Array.isArray(wanted) ? wanted.includes(got) : got === wanted;
  });
}

function readQuestionsFile(out) {
  if (!out) return [];
  try {
    return JSON.parse(fs.readFileSync(path.join(out, "questions.json"), "utf8"));
  } catch {
    return [];
  }
}

/** Plan object from the session + answered planning questions. */
export function resolveDevelopPlan(session) {
  const answers = {};
  for (const ask of session.asks || []) {
    if (ask.status === "answered") answers[ask.id] = ask.answer;
  }
  const base = {
    goal: session.brief || "",
    name: session.addon?.name || "",
    description: session.develop?.description || "",
    path: session.addon?.path || "",
    dir: session.addon?.path || "",
    origin: session.develop?.folder === "existing" ? "existing" : (answers.origin || "new"),
    designHint: answers.design || session.develop?.designHint || "",
    features: session.develop?.features || {}
  };
  return applyPlanning(base, answers);
}

function listingNext(session, { answered, published, ask }) {
  const choice = answered("listing");
  if (!choice) return ask("listing");
  if (choice.answer === "skip") {
    return { action: "run", command: "node scripts/session.mjs step --id listing --status skipped --detail \"No listing\"", say: "Skip the listing, then finish." };
  }
  const wantsText = choice.answer === "both" || choice.answer === "text";
  const wantsShots = choice.answer === "both" || choice.answer === "shots";
  if (wantsText && !session.listing && answered("listing-review")?.answer !== "approve") {
    return { action: "draft-listing", command: "node scripts/develop.mjs listing-text", say: "Draft the listing from the manifest and the panel, using the cloned submission notes. Then ask listing-review." };
  }
  if (wantsText && !published("listing-review")) return ask("listing-review");
  if (wantsText && answered("listing-review")?.answer === "redo") {
    return { action: "draft-listing", command: "node scripts/develop.mjs listing-text", say: "Draft the listing again from the same sources." };
  }
  const shotsReady = (session.shots || []).some((shot) => shot.kind === "listing");
  if (wantsShots && !shotsReady) {
    const shots = session.develop?.listingShots;
    if (shots === "failed" || shots === "skipped") {
      return {
        action: "run",
        command: "node scripts/session.mjs step --id listing --status skipped --detail \"Screenshots did not render. The listing step is not done.\"",
        say: "The screenshots did not render, so this step is not marked done. Do not run the same command again."
      };
    }
    return { action: "make-shots", command: "node scripts/develop.mjs listing-shots", say: "Render the screenshots with the cloned listing tools, then ask shots-review. If they do not render, the step is not done." };
  }
  if (wantsShots && !published("shots-review")) return ask("shots-review");
  return { action: "run", command: "node scripts/session.mjs step --id listing --status done --detail \"Listing handled\"", say: "Mark the listing done, then finish." };
}
