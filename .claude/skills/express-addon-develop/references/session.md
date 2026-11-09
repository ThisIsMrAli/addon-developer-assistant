# Develop session

A develop session is `kind: "develop"`. It uses Preflight's `session.json`, `answers.jsonl`, and `questions.json`. `session.mjs` here is the same CLI: `mode`, `ask`, `wait`, `answer`, `step`, `next`, `done`.

`next` reads the session and does not write it. Follow the `next` line. A build is not finished until `done`.

## Steps

The ids, in order:

1. `docs`
2. `origin`
3. `template` (optional; skipped for an existing add-on)
4. `feasibility`
5. `design`
6. `implement`
7. `build`
8. `package`
9. `audit`
10. `express` (optional, BETA)
11. `listing`
12. `done`

`express` is immediately before `listing`. Skipping it does not insert another step. The next question is `listing`, the listing text and the screenshots. Choosing run on a remote machine also skips, with a reason, and the next question is still `listing`. On a local machine, run asks `express-result` before the listing.

## Questions

- `mode` is asked in chat, before any fetch, before the dashboard starts.
- `origin` — `new` or `existing`.
- `template` — one id per option, from the fetch. The first option is the recommended one.
- `feasibility` — `iframe`, `sandbox`, or `unsupported`. The recommended option is the class the pages supported.
- `design` — `swc` or `leave`.
- `implement` — `write` or `stop`.
- `express` — "Run a real test in Adobe Express (beta)?" `skip` first, labelled recommended, then `run`.
- `express-result` — only after a local run. Stop is the recommended first option. The other choices are that the panel rendered and the feature was exercised, or that it failed or timed out. A pass also needs a screenshot of kind `express`.

Running `begin` again for the same folder resumes. It does not delete the add-on or the answers. `--empty` is only for an empty folder. One `current.json` points at the session, and starting another session stops the previous dashboard.
- `listing` — the Preflight listing question. `listing-review` and `shots-review` follow when there is something to approve.

On the dashboard, `ask` then `wait`. Do not call AskQuestion for that question. If `wait` returns `server-down`, ask in chat and record `answer`.
