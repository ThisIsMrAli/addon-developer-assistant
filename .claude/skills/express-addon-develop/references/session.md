# Develop session

A develop session is `kind: "develop"`. It uses Preflight's `session.json`, `answers.jsonl`, and `questions.json`. `session.mjs` here is the same CLI: `mode`, `ask`, `wait`, `answer`, `step`, `next`, `done`.

`next` reads the session and does not write it. Follow the `next` line. A build is not finished until `done`.

## Steps

The ids, in order:

1. `planning` — questions the request did not answer
2. `plan` — confirm the spec (Build it / Change something / Stop). Nothing is created before this
3. `docs`
4. `design`
5. `template` (optional; skipped for an existing add-on). The recommended template can edit the Express document.
6. `implement` — document editing is included. The developer is not asked iframe vs sandbox.
7. `build`
8. `package`
9. `audit`
10. `try`
11. `express` (optional, BETA)
12. `listing`
13. `done`

`express` is immediately before `listing`. Skipping it does not insert another step. The next question is `listing`. Choosing run on a remote machine also skips, with a reason. On a local machine, run asks `express-result` before the listing.

## Questions

- `mode` is asked in chat, before any fetch, before the dashboard starts.
- Planning (only what the sentence left open): `goal`, `name`, `description`, and up to two feature questions.
- `plan` — Build it, Change something, or Stop. `tweak` follows Change something, then `plan` is asked again.
- `design` — `swc` or `leave`. Asked before the template, so the recommendation can match.
- `template` — one id per option, from the fetch. The first option is the recommended one, and it can edit the Express document.
- `feedback` — try card after audit. Bugs (with words/screenshots) or no more bugs. Repeats until no more bugs.
- `express` — "Run a real test in Adobe Express (beta)?" `skip` first, labelled recommended, then `run`.
- `express-result` — only after a local run.
- `listing` — the Preflight listing question. `listing-review` and `shots-review` follow when there is something to approve.

Running `begin` again resumes a session that is still open. It does not delete the add-on or the answers. A finished session does not resume: `begin` starts a new one, and it does not delete the folder. `--goal` is the developer's request, word for word. `--empty` is only for an empty folder. A folder that is not empty and has no manifest is refused before a session is created. The session folder is `~/.express-addon-develop/<slug>/`.

On the dashboard, `ask` then `wait`. Do not call AskQuestion for that question. Text questions and the try card (screenshots) are supported on the dashboard. If `wait` returns `server-down`, start the dashboard and run `wait` again. Ask in chat only if start fails, then record `answer`.
