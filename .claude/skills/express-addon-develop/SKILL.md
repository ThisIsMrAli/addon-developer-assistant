---
name: express-addon-develop
description: >-
  Builds an Adobe Express add-on from an empty folder or extends one that
  already exists. It fetches Adobe's current docs, checks each feature against
  those pages, and writes nothing until you approve. The panel is then built,
  packaged, and walked by Add-on Preflight. A browser run uses an SDK stand-in
  and is not an Express pass. An optional BETA step, immediately before the
  listing, can open the add-on in real Adobe Express. Skip is the default.
  A cloud agent, SSH session, or container skips that step. Use when the user
  wants to create, scaffold, or add a feature to an Express add-on.
license: MIT
compatibility: Requires Node.js 18 or newer. The panel walk needs Chrome, Edge, or Chromium. The dashboard needs a browser on the same computer and falls back to chat when it cannot start.
---

# Express Add-on Develop Assistant

Build one Adobe Express add-on. The skill root is the directory that contains this file. Run the scripts from there. Sessions are written to `~/.express-addon-develop/`, not into the add-on.

This is Add-on Preflight with a development session in front of it. The review scripts, the dashboard, the audit, and the listing tools are the ones in `../express-addon-review`. Do not reimplement them. `session.mjs` and `dashboard.mjs` here forward to those scripts and point them at the develop session.

## The one rule: do not stop

A build ends at `session.mjs done`. Until then you are in the middle of a task.

- Every command prints a `next` line. Do what it says.
- Never end your turn with a message while the build is open. A message with no command after it ends your turn.
- Between `ask` and `wait`, write nothing to the user. The question is already on the dashboard.
- If you lose your place, run `node scripts/session.mjs next`.

Do not read every reference up front. Read the one for the step you are on.

## What this build is

Two places a build can happen. The user picks once, before any network call.

- **Dashboard.** A page in Chrome on this computer. You publish a decision with `session.mjs ask` and run `session.mjs wait` until they click. You do not also call AskQuestion for it.
- **Chat.** Nothing opens. You call AskQuestion for each decision and record the click with `session.mjs answer`.

AskQuestion is for the mode question, for chat mode, and for the moment `wait` reports `server-down`. It is not for a question that is already on the dashboard.

The headless audit does not open Adobe Express. A browser run of the panel is not an Express pass. The SDK stand-in is labelled `express-sdk-stand-in`. The optional beta step is the only place a real Express window is opened, and only after the person chooses Run on a machine that is not remote. This skill never types a password.

## Workflow

1. **Open the session.** No network yet.

```bash
node scripts/develop.mjs begin --dir /absolute/path --name "Name" --brief "What to add"
```

   `--dir` is an empty folder, or an add-on that already has a manifest. The session is written to `~/.express-addon-develop/<slug>/` unless you pass `--out`. `--name` is the marketplace name and is applied to the manifest. `--empty` means the folder is a new add-on. It is refused when the folder is not empty, and nothing is deleted. A folder that is not empty and has no manifest is refused at the start, and nothing is deleted. A folder that already has a manifest skips the empty-folder question. Running `begin` again on the same folder resumes the session and does not wipe answers or project files. Nothing is copied and nothing is fetched. A second session moves the pointer and leaves the previous dashboard running.

2. **Ask where to follow the build.** Call AskQuestion with the `mode` object in `questions.json`. Title is `Next step`. Pass `prompt` and each option's `id` and `label` through unchanged.

   - `dashboard`: `node scripts/session.mjs mode --set dashboard`, then `node scripts/dashboard.mjs start`. Say the link once, in one line, and carry on. If `ok` is false, say the reason in one sentence, run `session.mjs mode --set chat`, and continue in chat.
   - `chat`: `node scripts/session.mjs mode --set chat`.

   Commands and the wait contract: [references/dashboard.md](references/dashboard.md). The page itself is Preflight's dashboard.

3. **Docs.** `node scripts/develop.mjs docs`. Pages are fetched in parallel with a per-page timeout and an overall budget. Each page is `fresh`, `stale` (the cache was kept), or `failed`. The dashboard shows the counts. Do not call a stale page fresh.

4. **Origin.** Ask `origin`. An existing add-on skips the template step.

5. **Template.** Only for an empty folder. `node scripts/develop.mjs templates` reads `@adobe/create-ccweb-add-on` at that moment. There is no built-in list. If the fetch fails, say so and stop. Do not invent a name. The folder is still empty after the answer.

6. **Feasibility.** `node scripts/develop.mjs classify`, then ask `feasibility`. The classes are iframe UI, document sandbox APIs, and unsupported. The evidence sentence is copied from the fetched page. Read [references/feasibility.md](references/feasibility.md).

7. **Design.** Ask `design`. Spectrum Web Components stay the preference while the fetched implementation guide says so. A template with no webpack is not rewritten into one in the same step.

8. **Implement.** Ask `implement`. Until the answer is `write`, and until origin, template (when the folder is new), feasibility, and design are answered, no project file is written. `stop` ends the session with nothing written.

   `node scripts/develop.mjs implement` scaffolds a new folder and hands you the brief, the fetched pages, and the APIs. It does not write the feature. You write it, then record it:

```bash
node scripts/develop.mjs record
```

   Document text uses `editor.createText()` in the document sandbox, with a style. An image uses `addImage()` or `createImage()`. A Spectrum panel uses Spectrum Web Components (`sp-textfield`, `sp-button`, `sp-theme`). Network and OAuth need `permissions.oauth` in the manifest. `record` checks that the code calls those APIs, that the project builds, and that the manifest has the permissions. A stub (`featureReady`, a `develop-feature` field, or the template's Create Rectangle left as the feature) is rejected. The step is not done until `record` passes. Do not say the feature was written from the docs before that.

9. **Build and package.**

```bash
node scripts/develop.mjs build
node scripts/develop.mjs package
```

10. **Audit.** Preflight scans the add-on and walks the panel at 320px in light and dark. The browser is served a copy whose Adobe SDK import points at the stand-in. Record `expressPass: false`. Fix measured bugs the way Preflight's skill says, or report them. Do not call this an Express pass.

11. **BETA: real Express.** This step is optional and it sits immediately before the listing. Ask `express` on the dashboard, or with AskQuestion when the mode is chat. The prompt is "Run a real test in Adobe Express (beta)?" **Skip is the default** and the first option. Skip does not open Express, and the next question is the listing and the screenshots.

    `run` calls `node scripts/express-run.mjs`. On a cloud agent, an SSH session, or a container it skips and records the reason. On this computer it trusts the dev CA, starts `https://localhost:5241`, and opens a visible browser at `https://new.express.adobe.com` for the person to sign in. Do not type credentials. Do not disable Chrome flags. Do not pass `--ignore-certificate-errors`. Do not use `127.0.0.1`.

    Then ask `express-result`. A pass is recorded only when the panel rendered in Express, the feature was exercised, and a screenshot was saved with `session.mjs shot --kind express`. A failure or a timeout is recorded as that. Read [references/sideload.md](references/sideload.md) and [references/express-beta.md](references/express-beta.md).

12. **Listing and screenshots.** The same listing question, draft, and screenshot review as Preflight. Text and screenshots are shown before anything is written into the add-on. Nothing is submitted.

13. **Done.** `node scripts/session.mjs done --summary "..."`, then `node scripts/dashboard.mjs stop`. The summary says what was written, what was skipped, that the headless browser run used a stand-in, and whether the beta Express check passed, failed, or was skipped.

## References

- [references/session.md](references/session.md) — steps and questions
- [references/dashboard.md](references/dashboard.md) — the same dashboard and the same wait contract
- [references/feasibility.md](references/feasibility.md) — iframe, sandbox, unsupported
- [references/sideload.md](references/sideload.md) — trusting the dev CA for `https://localhost:5241`
- [references/express-beta.md](references/express-beta.md) — the optional real Express test, remote skip, and browser adapters
