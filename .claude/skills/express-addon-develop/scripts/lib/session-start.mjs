import fs from "node:fs";
import path from "node:path";
import { mutate, readMerged, setStep } from "../../../express-addon-review/scripts/lib/session.mjs";
import { DEVELOP_STEPS, initialQuestions, resolveDevelopPlan, templateAsk } from "./flow.mjs";
import { deriveName, isBlankGoal } from "./intent.mjs";
import { planAsk, planningQuestions, tweakAsk } from "./planning.mjs";
import { rememberOut } from "./paths.mjs";

function now() {
  return new Date().toISOString();
}

export function startDevelopSession(out, { name, dir, brief, goal }) {
  fs.mkdirSync(out, { recursive: true });
  const job = String(goal || brief || "").trim();
  const displayName = name || (isBlankGoal(job) ? "Express Add On" : deriveName(job));
  const plan = {
    goal: job,
    name: displayName,
    description: "",
    path: dir || "",
    dir: dir || "",
    origin: "",
    designHint: "",
    features: {}
  };
  const session = {
    v: 1,
    rev: 0,
    kind: "develop",
    mode: null,
    startedAt: now(),
    updatedAt: now(),
    addon: { name: displayName, path: dir || "", docsSha: "", fetchedAt: "" },
    brief: job,
    baseline: [],
    steps: DEVELOP_STEPS.map((step) => ({
      id: step.id,
      label: step.label,
      optional: Boolean(step.optional),
      hint: step.hint || "",
      status: "pending",
      detail: "",
      doing: "",
      progress: null,
      startedAt: null,
      endedAt: null
    })),
    notes: [],
    asks: [],
    shots: [],
    listing: null,
    audit: null,
    docs: null,
    templates: null,
    feasibility: null,
    develop: { implemented: false, built: false, packaged: false, audited: false, expressSetup: false, expressHostRan: false, features: {} },
    agentSeenAt: now(),
    log: [{ at: now(), step: "", text: "Development session opened. No network yet." }],
    summary: null,
    needsCredential: false
  };
  fs.writeFileSync(path.join(out, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  fs.writeFileSync(path.join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  fs.writeFileSync(path.join(out, "questions.json"), `${JSON.stringify(initialQuestions(plan), null, 2)}\n`);
  fs.writeFileSync(path.join(out, "report.json"), `${JSON.stringify({ addon: session.addon.name, addonPath: dir || "", findings: [], skipped: [], views: [] }, null, 2)}\n`);
  rememberOut(out);
  return session;
}

/** Rebuild planning + plan questions from current answers. Returns the plan. */
export function refreshPlanCard(out) {
  const session = readMerged(out) || JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8"));
  const plan = resolveDevelopPlan(session);
  const file = path.join(out, "questions.json");
  const questions = JSON.parse(fs.readFileSync(file, "utf8"));
  const mode = questions.find((item) => item.id === "mode");
  const rest = questions.filter((item) => !["mode", "plan", "tweak", "goal", "name", "description", "feat-layout", "feat-token"].includes(item.id) && !String(item.id).startsWith("feat-"));
  const next = [mode, ...planningQuestions(plan), planAsk(plan), tweakAsk(), ...rest].filter(Boolean);
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  fs.writeFileSync(path.join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  mutate(out, (draft) => {
    draft.brief = plan.goal;
    draft.addon.name = plan.name;
    draft.develop = {
      ...(draft.develop || {}),
      description: plan.description || "",
      features: plan.features || {},
      planCardFresh: true
    };
  });
  return plan;
}

export function upsertQuestion(out, question) {
  const file = path.join(out, "questions.json");
  const all = JSON.parse(fs.readFileSync(file, "utf8"));
  const index = all.findIndex((item) => item.id === question.id);
  if (index >= 0) all[index] = question;
  else all.push(question);
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
}

export function saveDocs(out, docs) {
  return mutate(out, (draft) => {
    draft.docs = docs;
    if (docs.fetchedAt) draft.addon.fetchedAt = docs.fetchedAt;
    if (docs.sha) draft.addon.docsSha = docs.sha;
  });
}

export function saveTemplates(out, templates, design = "") {
  let brief = "";
  try {
    brief = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8")).brief || "";
  } catch {
    brief = "";
  }
  upsertQuestion(out, templateAsk(templates.ids, brief, design));
  return mutate(out, (draft) => {
    draft.templates = templates;
  });
}

export function saveFeasibility(out, feasibility) {
  return mutate(out, (draft) => {
    draft.feasibility = feasibility;
  });
}

export function patchDevelop(out, patch) {
  return mutate(out, (draft) => {
    draft.develop = { ...(draft.develop || {}), ...patch };
    if (patch.addonPath) draft.addon.path = patch.addonPath;
    if (patch.name) draft.addon.name = patch.name;
    if (patch.brief !== undefined) draft.brief = patch.brief;
  });
}

export { setStep };
