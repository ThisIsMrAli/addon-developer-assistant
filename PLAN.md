# Plan

The Express Add-on Develop Assistant is the attached Add-on Preflight tree (`express-addon-review`, 0.4.0) plus a development flow. It is not a new boilerplate. Preflight's scripts, tests, dashboard, audit, listing templates, and Spectrum notes stay in place and keep their behavior.

## Cloned and left on the same contract

- `.claude/skills/express-addon-review/` including `SKILL.md` (the "do not stop" rule, the voice, and the review workflow), `references/`, `assets/dashboard/`, `assets/audit/`, and `scripts/`.
- `session.mjs` commands: `mode`, `ask`, `wait`, `answer`, `step`, `next`, `done`, `secret`, `show`, `note`, `shot`, `listing`. Every command still prints a `next` line.
- `dashboard.mjs` and `scripts/lib/server.mjs`: bind `127.0.0.1`, random token, Host check, Origin check, 64 KB JSON body, one answer per question, CSP, `textContent`, `server.json` mode `0600`, idle stop, 25 second wait capped at 110.
- Docs refresh (`refresh-docs.mjs`) and `references/live/summary.json`. A check still skips when its sentence is missing from that download.
- Headless Chrome build-and-serve audit at 320px in light and dark (`audit.mjs`).
- Listing lockup and Spectrum references.
- `test/` for the review, `CHANGELOG.md` / `README.md` shape, MIT `LICENSE`, and `install-agents.mjs` symlinks for the agent folders.

Review sessions still use the steps `scan`, `panel`, `access`, `fix`, `design`, `polish`, `listing`, `done`. `next` for those sessions is unchanged.

The copyright line in `LICENSE` stays `Copyright (c) 2026 express-addon-review contributors`. This tree is a derivative. The notice is not rewritten.

## Added

Skill: `.claude/skills/express-addon-develop/`.

A develop session (`kind: "develop"`) is a second step list on the same session file and the same dashboard. `next` branches on `kind` and does not change a review.

Steps, in order (aligned with UXP Assistant):

1. `planning` — only the gaps the request left open (job, name, screen, feature choices).
2. `plan` — confirm the spec (Build it / Change something / Stop). Nothing is fetched or written before Build it.
3. `docs` — live-fetch Adobe Express add-on pages in parallel, per-page timeout and an overall budget. Each page is `fresh`, `stale` (cache used), or `failed`. Counts are on the session, so the dashboard shows them.
4. `origin` — empty folder or an existing add-on.
5. `template` — only for an empty folder. Names come from the current `@adobe/create-ccweb-add-on` package (constants and the templates directory) checked against the tooling page. No built-in list. If the fetch fails, the list is empty and scaffolding is refused.
6. `feasibility` — one decision per feature: iframe UI, document sandbox APIs, or unsupported. The choice cites a sentence that is actually in the fetched (or cached) page.
7. `design` — Spectrum Web Components when the implementation guide still says to prefer them.
8. `implement` — write the feature after the spec is confirmed; `record` verifies it.
9. `build`
10. `package`
11. `audit` — Preflight's own scan and `audit.mjs` on the add-on. The browser run injects an SDK stand-in labelled `express-sdk-stand-in`. That run is not an Express pass.
12. `try` — human feedback loop (words and screenshots) until "No more bugs".
13. `express` — **BETA: real Express.** Optional. Its own ask, on the dashboard or in chat: "Run a real test in Adobe Express (beta)?" **Skip is the default** and the recommended option. It sits immediately before listing. Skip does not open Express and the next question is the listing and the screenshots. Run, on a local machine, trusts the dev CA, starts `https://localhost:5241`, opens a visible browser at `https://new.express.adobe.com` for the person to sign in, and asks for the result. A pass is only the panel rendered in Express, the feature exercised, and a screenshot. A failure or a timeout is recorded as that. A cloud agent, SSH session, or container skips with a reason and does not launch.
14. `listing` — the cloned listing text and screenshot path.
15. `done`

Mode is asked before any network call. Planning and the confirm card come before docs. The dashboard supports text answers and screenshot attach (for planning and try). Later questions use `ask` / `wait` on the dashboard. AskQuestion is only for the mode question, for chat mode, and for the documented server-down fallback. Start with `begin --goal "<request, word for word>"`.

The Linux setup command (`setup-express-linux.mjs`) mirrors the known-working dev-CA trust script. It installs `certutil` with apt, and if that mirror fails it downloads `libnss3-tools` from the Debian security pool and then the Debian pool, using the installed `libnss3` version with the epoch stripped. It trusts `~/.config/Adobe/CCWebAddOn/devcert/certificate-authority/certificate.cert` as nickname `adobe-ccweb-devcert` with trust `C,,` in `sql:$HOME/.pki/nssdb` and `sql:$HOME/.local/share/pki/nssdb`, and it verifies the trust line. A missing CA exits 2. The command never disables a Chrome flag, never passes `--ignore-certificate-errors`, and never uses `127.0.0.1`. The Express clicks and the sign-in stay with the person.

Browser launch is detected. Cursor's Browser tool is used when the host agent exposes it (documented at `https://cursor.com/docs/agent/tools/browser`, no shell binary). Otherwise local Chrome or Edge is opened visibly, via `CHROME_PATH` or `PATH`, in a persistent profile. Claude Code's `claude --chrome` / `/chrome` and Codex's computer-use API were checked against current docs. Neither is a command this skill invokes; the fallback is local Chrome plus the checklist buttons. Sources are in `references/express-beta.md`.

`install-agents.mjs` links both skills.

## Test plan

- Existing Preflight tests still pass.
- Workflow: `begin` makes no network call; time-to-dashboard for a develop session and for a Preflight session is measured until the loopback URL returns 200; dashboard-mode `ask` does not mention AskQuestion; `wait` after the server stops does.
- Step order: `express` is immediately before `listing`, the step is optional, skip is the first option, and a skip answer's next action is the listing question.
- Beta ask text, dashboard versus chat, the remote skip, setup (apt fallback, both NSS databases, missing CA exits 2, no ignore-cert and no `127.0.0.1`), adapter detection, and a mocked launch. A pass is rejected unless the panel rendered, the feature was exercised, and a screenshot exists. Timeouts are not passes.
- Full develop question sequence through `ask` / `wait` (mode, origin, template, feasibility, design, implement, express, listing).
- Docs labels: fresh, stale, and failed, including a forced failure that uses the cache.
- Template parser: ids are taken from fixture text, and the live package list matches the text that was fetched. The templates module contains no hardcoded template-id list.
- No write before the gate. An existing add-on gains a caption field only after the answers, then a zip with `manifest.json` at the root.
- Empty-folder end to end: one real template from the live list, `npm run build`, a package zip, and Preflight's audit with the stand-in and zero measured bugs.
- `scripts/box-test.mjs` runs the suite with browser and network end-to-end tests skipped, from the repository root.

## Not in this run

No push to GitHub, including `https://github.com/ThisIsMrAli/addon-developer-assistant`. No marketplace submission. The machine this archive was built on is a cloud agent, so the beta Express step skips there. A real Express pass is not claimed from that run.
