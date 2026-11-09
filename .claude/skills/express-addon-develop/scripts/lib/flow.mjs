/**
 * Develop-session steps and the `next` decision.
 * A review session never reaches this. Skip on the BETA Express step goes straight to listing.
 */

export const DEVELOP_STEPS = [
  { id: "docs", label: "Fetch the Adobe docs", hint: "Live pages, in parallel, with a time budget. Each page is fresh, stale, or failed." },
  { id: "origin", label: "Choose the starting point", hint: "An empty folder, or an add-on you already have." },
  { id: "template", label: "Pick a template", optional: true, hint: "Only for an empty folder. The names come from Adobe's CLI, fetched this session." },
  { id: "feasibility", label: "Check each feature", hint: "iframe UI, document sandbox APIs, or unsupported, from the pages just fetched." },
  { id: "design", label: "Design for Express", hint: "Spectrum Web Components when the implementation guide still prefers them." },
  { id: "implement", label: "Implement from the docs", hint: "No project file is written before this answer." },
  { id: "build", label: "Build", hint: "The add-on's own build." },
  { id: "package", label: "Package", hint: "A zip with the manifest at its root." },
  { id: "audit", label: "Run Add-on Review", hint: "The cloned audit at 320px in light and dark. A browser run is not an Express pass." },
  { id: "express", label: "BETA: real Express", optional: true, hint: "Optional. Skip is the default. A pass is only a panel that rendered in Express with the feature exercised. Remote machines skip." },
  { id: "listing", label: "Listing and screenshots", hint: "Text and screenshots are shown before anything is written into the add-on." },
  { id: "done", label: "Wrap up" }
];

const OPEN = new Set(["pending", "running", "waiting"]);

export function initialQuestions() {
  return [modeAsk(), originAsk(), designAsk(), implementAsk(), expressAsk(), listingAsk()];
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

export function implementAsk() {
  return {
    id: "implement",
    title: "Write the feature",
    prompt: "Write the feature from the fetched docs? Nothing has been written to the add-on yet.",
    options: [
      { id: "write", label: "Write the feature from the docs (Recommended)", detail: "Edits only what the feasibility answer allows, citing the page that allowed it." },
      { id: "stop", label: "Stop", detail: "Writes nothing and ends the session." }
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

export function templateAsk(ids) {
  const options = ids.map((id, index) => ({
    id,
    label: index === 0 ? `${id} (Recommended)` : id,
    detail: index === 0 ? "First name in the list Adobe's CLI published for this fetch." : "Fetched from the CLI package. Not a remembered list."
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
 * @param {{ dashboardUp?: boolean }} options
 */
export function developNext(session, { dashboardUp = false } = {}) {
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

  if (step("done")?.status === "done") {
    const passed = session.develop?.expressPass === true;
    const expressLine = passed
      ? "The beta Express check passed: the panel rendered and the feature was exercised."
      : "The beta Express check did not pass.";
    return { action: "finished", say: `The build is finished. Give the user the summary. Run \`node scripts/dashboard.mjs stop\` if the dashboard is still up. ${expressLine} This is not marketplace approval.` };
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
      : { action: "ask-in-chat", ask: pending.id, say: `Ask "${pending.title || pending.id}" with AskQuestion, then record the click with \`session.mjs answer --id ${pending.id} --value <option id>\`.` };
  }

  if (open("docs")) {
    if (!session.docs) {
      return { action: "run", command: "node scripts/develop.mjs docs", say: "Fetch the Adobe docs now. The dashboard shows fresh, stale, and failed as the pages return." };
    }
    const counts = session.docs.counts || {};
    return { action: "run", command: `node scripts/session.mjs step --id docs --status done --detail "${counts.fresh || 0} fresh, ${counts.stale || 0} stale, ${counts.failed || 0} failed"`, say: "The fetch is recorded. Mark the docs step done." };
  }

  if (open("origin")) {
    if (!answered("origin")) return ask("origin");
    return { action: "run", command: "node scripts/session.mjs step --id origin --status done --detail \"Starting point chosen\"", say: "Mark the origin step done." };
  }

  if (open("template")) {
    if (answered("origin")?.answer === "existing") {
      return { action: "run", command: "node scripts/session.mjs step --id template --status skipped --detail \"An existing add-on does not get a template\"", say: "Skip the template step." };
    }
    if (!session.templates?.ids?.length) {
      return { action: "run", command: "node scripts/develop.mjs templates", say: "Fetch the template names from the CLI package. Do not invent a list. If the fetch fails, stop and say so." };
    }
    if (!answered("template")) return ask("template");
    return { action: "run", command: "node scripts/session.mjs step --id template --status done --detail \"Template chosen\"", say: "Mark the template step done. The folder is still empty." };
  }

  if (open("feasibility")) {
    if (!session.feasibility?.class) {
      return { action: "run", command: "node scripts/develop.mjs classify", say: "Classify the feature from the fetched pages: iframe UI, document sandbox, or unsupported." };
    }
    if (!answered("feasibility")) return ask("feasibility");
    return { action: "run", command: "node scripts/session.mjs step --id feasibility --status done --detail \"Feasibility answered\"", say: "Mark feasibility done. Still write nothing." };
  }

  if (open("design")) {
    if (!answered("design")) return ask("design");
    return { action: "run", command: "node scripts/session.mjs step --id design --status done --detail \"Design answered\"", say: "Mark design done. Still write nothing." };
  }

  if (open("implement")) {
    if (!answered("implement")) return ask("implement");
    if (answered("implement").answer === "stop") {
      return { action: "finish", command: "node scripts/session.mjs done --summary \"Stopped before any file was written.\"", say: "The user stopped before the write. Close the session. No project file was written." };
    }
    if (!session.develop?.implemented) {
      return { action: "run", command: "node scripts/develop.mjs implement", say: "The gate is open. Scaffold if this is a new folder, then implement the feature from the docs." };
    }
    return { action: "run", command: "node scripts/session.mjs step --id implement --status done --detail \"Feature written from the docs\"", say: "Mark implement done." };
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
    return { action: "run", command: "node scripts/session.mjs step --id audit --status done --detail \"Audit finished\"", say: "Mark the audit done. The BETA Express step is next, and it is optional." };
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

  if (answered("express")?.answer === "run" && (session.develop?.expressRemote || session.develop?.expressBlocked)) {
    if (open("listing") && !published("listing")) return ask("listing");
    if (open("express")) {
      const remote = Boolean(session.develop?.expressRemote);
      const detail = remote ? "Remote machine: real Express was not opened" : "Beta check stopped before Express. See express-host.json";
      const status = remote ? "skipped" : "done";
      const say = remote
        ? "This machine is remote, so the beta Express test was skipped. The listing is next."
        : "The beta check failed before Express. It is not a pass. The listing is next.";
      return { action: "run", command: `node scripts/session.mjs step --id express --status ${status} --detail "${detail}"`, say };
    }
  }

  if (answered("express")?.answer === "run" && session.develop?.expressChecked && !session.develop?.expressRemote && !session.develop?.expressBlocked) {
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

  const passed = session.develop?.expressPass === true;
  const summary = passed
    ? "Beta Express passed: the panel rendered and the feature was exercised. This is not marketplace approval."
    : "Beta Express did not pass. This is not marketplace approval.";
  return { action: "finish", command: `node scripts/session.mjs done --summary "${summary}"`, say: "Run done, then stop the dashboard. Say whether the beta Express check passed, failed, or was skipped. Do not call it marketplace approval." };
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
  if (wantsShots && !(session.shots || []).some((shot) => shot.kind === "listing")) {
    if (session.develop?.listingShots !== "skipped") {
      return { action: "make-shots", command: "node scripts/develop.mjs listing-shots", say: "Render the screenshots with the cloned listing tools, then ask shots-review. If Chrome cannot run, the command says so and does not claim a capture." };
    }
  }
  if (wantsShots && session.develop?.listingShots !== "skipped" && !published("shots-review")) return ask("shots-review");
  const skippedShots = wantsShots && session.develop?.listingShots === "skipped";
  const detail = skippedShots ? "Listing handled. Screenshots were not taken" : "Listing handled";
  const say = skippedShots
    ? "Screenshots were not taken, and nothing was claimed as captured. Mark the listing done, then finish."
    : "Mark the listing done, then finish.";
  return { action: "run", command: `node scripts/session.mjs step --id listing --status done --detail "${detail}"`, say };
}
