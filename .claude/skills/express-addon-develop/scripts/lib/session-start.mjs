import fs from "node:fs";
import path from "node:path";
import { mutate, setStep } from "../../../express-addon-review/scripts/lib/session.mjs";
import { DEVELOP_STEPS, feasibilityAsk, initialQuestions, templateAsk } from "./flow.mjs";
import { rememberOut } from "./paths.mjs";

function now() {
  return new Date().toISOString();
}

export function startDevelopSession(out, { name, dir, brief }) {
  fs.mkdirSync(out, { recursive: true });
  const session = {
    v: 1,
    rev: 0,
    kind: "develop",
    mode: null,
    startedAt: now(),
    updatedAt: now(),
    addon: { name: name || "Express add-on", path: dir || "", docsSha: "", fetchedAt: "" },
    brief: brief || "",
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
    develop: { implemented: false, built: false, packaged: false, audited: false, expressSetup: false, expressHostRan: false },
    agentSeenAt: now(),
    log: [{ at: now(), step: "", text: "Development session opened. No network yet." }],
    summary: null,
    needsCredential: false
  };
  fs.writeFileSync(path.join(out, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  fs.writeFileSync(path.join(out, "questions.json"), `${JSON.stringify(initialQuestions(), null, 2)}\n`);
  fs.writeFileSync(path.join(out, "report.json"), `${JSON.stringify({ addon: session.addon.name, addonPath: dir || "", findings: [], skipped: [], views: [] }, null, 2)}\n`);
  rememberOut(out);
  return session;
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

export function saveTemplates(out, templates) {
  let brief = "";
  try {
    brief = JSON.parse(fs.readFileSync(path.join(out, "session.json"), "utf8")).brief || "";
  } catch {
    brief = "";
  }
  upsertQuestion(out, templateAsk(templates.ids, brief));
  return mutate(out, (draft) => {
    draft.templates = templates;
  });
}

export function saveFeasibility(out, feasibility) {
  upsertQuestion(out, feasibilityAsk(feasibility));
  return mutate(out, (draft) => {
    draft.feasibility = feasibility;
  });
}

export function patchDevelop(out, patch) {
  return mutate(out, (draft) => {
    draft.develop = { ...(draft.develop || {}), ...patch };
    if (patch.addonPath) draft.addon.path = patch.addonPath;
  });
}

export { setStep };
