---
name: express-addon-develop
description: >-
  Builds an Adobe Express add-on from one sentence, or extends one that already
  exists. It reads the name and job from the request, asks on the dashboard for
  anything the sentence did not say, then one confirm card the person must
  accept, then fetches Adobe's current docs, scaffolds, writes, builds, packages,
  and walks the panel with Add-on Preflight. Then the developer tries it and
  sends bugs as words and screenshots; it fixes them and asks again until they
  say there are none. An optional BETA step can open real Adobe Express before
  the listing. Skip is the default. A cloud agent, SSH session, or container
  skips that step. Use when the user wants to create, scaffold, or add a feature
  to an Express add-on.
license: MIT
compatibility: Requires Node.js 18 or newer. The panel walk needs Chrome, Edge, or Chromium. The dashboard needs a browser on the same computer and falls back to chat when it cannot start.
---

# Express Add-on Develop Assistant

Turn one request into a built Adobe Express add-on. The skill saves the docs, plans, scaffolds, checks, and packages. You write the add-on.

The skill root is the directory that contains this file. Run the scripts from there. Sessions are written to `~/.express-addon-develop/<slug>/`, not into the add-on. This is Add-on Preflight with a development session in front of it. The review scripts, the dashboard, the audit, and the listing tools are the ones in `../express-addon-review`. Do not reimplement them.

## The one rule: do not stop

A session ends at `session.mjs done`. Until then you are in the middle of a task.

- Every command prints a `next` line. Do what it says.
- Never end your turn with a message while the session is open. A message with no command after it ends your turn.
- Ask every question `next` names, including the planning questions and the confirm card. In dashboard mode you publish the card and wait. You never answer it. You never pick Build it. A sentence in chat is not a click on the dashboard: the person still confirms the spec.
- Between `ask` and `wait` (dashboard mode), write nothing to the user.
- Long commands (`docs`, `build`, `audit`) take up to a minute. Wait for them. Do not report on them.
- If you lose your place, or the user types "continue", run `node scripts/session.mjs next`. If that says the session is finished and they want another add-on, run `begin` again. A finished session does not block a new one, and it does not delete the folder.

## Start

```bash
node scripts/develop.mjs begin --dir /absolute/path --goal "<the developer's request, word for word>"
```

Use `--dir` for an empty folder, or an add-on that already has a manifest. Pass `--goal ""` when they only invoked the skill and did not describe an add-on. Do not pass the skill name as the goal. Do not invent a name or brief the sentence did not say — the planning step asks for those.

- `--name` and `--brief` still work as overrides when the developer already chose them.
- `--empty` means the folder is a new add-on. It is refused when the folder is not empty.
- Add `--mode` is not a begin flag: mode is asked first. For a background or cloud run with nobody to answer, set chat after begin and use `feedback --skip` later.

## The flow

Each command's `next` line names the command that follows it. Do what it says.

| Step | What it does | Questions |
| --- | --- | --- |
| mode | Dashboard (a page on this computer) or chat | one |
| planning | What the sentence did not say. No sentence at all asks for the job, the name, and the screen | those, one at a time |
| plan | The spec, read back. Build it, change something, or stop. A full sentence in chat still stops here until they confirm | one (a text answer only if they change something) |
| docs | Live-fetch Adobe Express pages in parallel. The dashboard says this is happening | none |
| design | Spectrum Web Components, or keep the template's controls | one |
| template | Template ids from `@adobe/create-ccweb-add-on`. The recommended one can edit the Express document. Skipped for an add-on that already exists | one |
| implement | You write the feature. Document editing is included. Keep the dashboard line moving with `session step --doing` | none |
| build / package | The add-on's own build and zip | none |
| audit | Preflight at 320px in light and dark with an SDK stand-in. Not an Express pass | none |
| try | `feedback` shows how to load it. The developer sends bugs (words, screenshots) or says no more bugs. You fix and ask again | one card, repeated until they say no more bugs |
| express | Optional BETA real Express. Skip is the default | one |
| listing | Marketplace text and screenshots, shown before write | the Preflight listing questions |
| done | `session.mjs done --summary "..."` | none |

Nothing is created until they choose **Build it**. Docs are not fetched before that.

## Writing the add-on

Plan the source layout before writing. Keep the entry point focused on wiring the UI and put independently testable feature logic and I/O behind named modules. Read [Code organization](references/code-organization.md) before implementing, and review the changed files against it before running `record`. Apply the same boundaries when fixing feedback.

After `implement` hands you the brief, the fetched pages, and the APIs, you write the feature. Then:

```bash
node scripts/develop.mjs record
```

If this step writes or edits `manifest.json`, keep `name` matching `^[a-zA-Z0-9]+[a-zA-Z0-9 ]{2,44}$` and keep `testId`. When the design answer is Spectrum, `docs` fetches the current `@spectrum-web-components/bundle` and every `sp-*` tag its packages export, and writes `docs/spectrum/catalog.md`. That file is the set. The handoff's examples (tabs, picker, switch, color, button) are examples, not the whole catalog. Use a tag from the file and open its docs URL before using it. `record` accepts any tag in that catalog and rejects a tag that is not. A plain button, or a button used as a tab or a menu item, is still not done. In React, omit `disabled`, `pending`, `selected`, and `checked` when the value is false. A present attribute is true in Spectrum, even when the JSX value is false. Set the DOM property from an effect instead. Subscribe to theme changes with `AppEvent.themechange`. The audit stand-in exports `AppEvent`. Document text uses `editor.createText()` in the document sandbox. Images use `keepContentActiveDuringAsync` as the Editor reference shows. `editor.queueAsyncEdit()` was removed and is rejected. The document sandbox may lack ES2022+ built-ins (`at`, `replaceAll`, …). Do not say the feature was written from the docs before `record` passes.

## Try, report, fix, repeat

After `audit` is done, `next` says to run `node scripts/develop.mjs feedback`. That first checks port 5241. If this add-on is already running, the try card says so. If nothing is running, one question asks whether to start it (`npm start -- --analytics off`, https://localhost:5241). A remote machine, a blocked loopback policy, or a different add-on already on that port does not start a server. The try card then says how to load it, with a box for words and screenshots, and two choices, "Something is wrong, or I want a change" and "No more bugs, finish trying". Wait for it like any other question.

When the answer is the first choice, `wait` prints their `text` and the file path of each screenshot in `images`. Then:

1. Read the words and open every screenshot (you can view images). Say to yourself what is wrong and what they expected.
2. The report is already note `fb1`. For more than one problem, add a note each: `node scripts/session.mjs note --id fb1-1 --text "..."`.
3. Fix the code. Change only what the report names. Never remove a feature to make a problem go away.
4. Run `record`, then build and package, until they pass. Mark each fixed note with `session.mjs note --id <id> --status fixed`, and ask again: `node scripts/develop.mjs feedback --changed "<one line: what you changed>"`.

The loop ends only when the developer chooses "No more bugs". You never decide that. If no person is there, `feedback --skip`.

## BETA: real Express

Optional, immediately before the listing. Skip is the default. On this computer `run` trusts the dev CA, starts `https://localhost:5241`, and opens Express for sign-in. Do not type credentials. Do not use `127.0.0.1`. Pass `--analytics off` on every `ccweb-add-on-scripts` command. Read [references/sideload.md](references/sideload.md) and [references/express-beta.md](references/express-beta.md).

## Finish

Run `node scripts/session.mjs done --summary "..."`, then `node scripts/dashboard.mjs stop`. The summary says what was written, that the headless walk used a stand-in, whether they tried it, and whether the beta Express check passed, failed, or was skipped.

## References

- [references/session.md](references/session.md) — steps and questions
- [references/dashboard.md](references/dashboard.md) — the same dashboard and the same wait contract
- [references/feasibility.md](references/feasibility.md) — iframe, sandbox, unsupported
- [references/sideload.md](references/sideload.md) — trusting the dev CA for `https://localhost:5241`
- [references/express-beta.md](references/express-beta.md) — the optional real Express test
- [references/sandbox-apis.md](references/sandbox-apis.md) — document sandbox APIs and limits
