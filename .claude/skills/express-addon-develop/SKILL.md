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

5. **Template.** Only for an empty folder. `node scripts/develop.mjs templates` reads `@adobe/create-ccweb-add-on` at that moment. There is no built-in list. If the fetch fails, say so and stop. Do not invent a name. The folder is still empty after the answer. The scaffold that writes the folder is pinned to `@adobe/create-ccweb-add-on@3.11.0` and passes `--analytics off`. It fills `src/manifest.json` the way `@adobe/ccweb-add-on-scaffolder` does: `testId` is a UUID, and `name` matches `^[a-zA-Z0-9]+[a-zA-Z0-9 ]{2,44}$`. `heading-panel` is the folder name. The display name is `Heading Panel`.

6. **Feasibility.** `node scripts/develop.mjs classify`, then ask `feasibility`. The classes are iframe UI, document sandbox APIs, and unsupported. The evidence sentence is copied from the fetched page. Read [references/feasibility.md](references/feasibility.md).

7. **Design.** Ask `design`. Spectrum Web Components stay the preference while the fetched implementation guide says so. A template with no webpack is not rewritten into one in the same step.

8. **Implement.** Ask `implement`. Until the answer is `write`, and until origin, template (when the folder is new), feasibility, and design are answered, no project file is written. `stop` ends the session with nothing written.

   `node scripts/develop.mjs implement` scaffolds a new folder and hands you the brief, the fetched pages, and the APIs. It does not write the feature. You write it, then record it:

```bash
node scripts/develop.mjs record
```

   If this step writes or edits `manifest.json`, keep `name` matching `^[a-zA-Z0-9]+[a-zA-Z0-9 ]{2,44}$` and keep `testId`. A hyphen, an empty name, or a placeholder such as `placeholder` fails `record`. An existing add-on's name is left as it is. A name that already matches, such as `Color Note e`, is not rewritten.

   The docs step fetches the how-to pages the brief needs (text, images, OAuth, renditions) as well as the platform pages. Document text uses `editor.createText()` in the document sandbox file, with a style. Place it inside the current page. Read the page size from `editor.context.insertionParent` (`width` and `height`) as [use-text.md](../express-addon-review/references/live/src/pages/guides/learn/how-to/use-text.md) shows. Cap the font with `Math.min(72, page width / 16)` and call `resize()` with `constants.ResizeBehavior.contain` for both width and height, only when the text is larger than the page minus a margin, as [resize-elements.md](../express-addon-review/references/live/src/pages/guides/learn/how-to/resize-elements.md) shows for text. Stack headings on one centre line with `setPositionInParent`, using `centerPointLocal` from `boundsLocal`, as [position-elements.md](../express-addon-review/references/live/src/pages/guides/learn/how-to/position-elements.md) shows. The next heading goes below the previous one, or below the selection (`boundsInParent`). Open a second column, on its own centre line, only when the first column cannot take another heading at a readable size (about 24px). Do not shrink a heading to a few pixels, and do not drop it onto an earlier row. When nothing readable fits, leave the node off the page and say the page is full. An empty field shows "Type a heading first." and adds nothing. The default 100pt text sits on the top-left origin and runs off the left edge. The handoff includes this snippet. `record` rejects inserted text that has no positioning or bounds. An image is built in the document sandbox. Adobe's Editor reference (`keepContentActiveDuringAsync`, Example 2, "Load an image from a Blob") awaits `editor.loadBitmapImage(blob)`, then calls `editor.keepContentActiveDuringAsync(insertionParent, async () => {}, afterAsyncCallback)`. `createImageContainer()` runs in that afterAsyncCallback. The async lambda does not edit the document. `editor.queueAsyncEdit(callback)` is the other accepted form. Fit the image to the space below the heading column ([resize-elements.md](../express-addon-review/references/live/src/pages/guides/learn/how-to/resize-elements.md)) and place it with `boundsInParent` ([position-elements.md](../express-addon-review/references/live/src/pages/guides/learn/how-to/position-elements.md)). A later heading continues the same centre line, and the image moves down. A centered `addImage()` covers the heading under it. `this._sandboxProxy.addImage(blob)` is a call to the sandbox, not `addOnUISdk.app.document.addImage`. `record` rejects an image that skips the documented callback or does not share that layout, and it rejects a panel call to a sandbox method `runtime.exposeApi` does not expose. A Spectrum panel uses Spectrum Web Components (`sp-textfield`, `sp-button`, `sp-theme`). OAuth uses `addOnUISdk.app.oauth.authorize()` inside a catch, and the host list is `entryPoints[].permissions.oauth`. Tokens use `clientStorage`. A rendition uses `createRenditions`, and a download needs `allow-downloads` on that same entry point. `record` parses the code, so a name that appears only in a comment does not count, and a syntax error fails even when the bundler exits 0. A stub is rejected. `--name` is not written over an existing manifest. Do not say the feature was written from the docs before `record` passes.

9. **Build and package.**

```bash
node scripts/develop.mjs build
node scripts/develop.mjs package
```

10. **Audit.** Preflight scans the add-on and walks the panel at 320px in light and dark. The browser is served a copy whose Adobe SDK import points at the stand-in. Record `expressPass: false`. Fix measured bugs the way Preflight's skill says, or report them. Do not call this an Express pass.

11. **BETA: real Express.** This step is optional and it sits immediately before the listing. Ask `express` on the dashboard, or with AskQuestion when the mode is chat. The prompt is "Run a real test in Adobe Express (beta)?" **Skip is the default** and the first option. Skip does not open Express, and the next question is the listing and the screenshots.

    `run` calls `node scripts/express-run.mjs`. On a cloud agent, an SSH session, or a container it skips and records the reason. On this computer it trusts the dev CA, starts `https://localhost:5241`, and opens a visible browser at `https://new.express.adobe.com` for the person to sign in. Do not type credentials. Do not disable Chrome flags. Do not pass `--ignore-certificate-errors`. Do not use `127.0.0.1` as the Express address.

    Pass `--analytics off` on every `ccweb-add-on-scripts` command the skill runs, and on a command you run yourself: `npm start -- --analytics off`, `npm run build -- --analytics off`, and `npm run package -- --analytics off`. The flag is `analytics` with options `on` and `off` on `@adobe/ccweb-add-on-analytics` `BaseCommand`. Leaving it off asks "Do you want to allow sending analytics to Adobe" and the process exits. `off` stores consent as false and does not send analytics. The default here is off.

    Adobe's dev server (`ccweb-add-on-scripts`) binds `[::1]:5241` only. Probe both `[::1]` and `127.0.0.1`, and say which one is listening. A check that resolves `localhost` to `127.0.0.1` is connection refused even though `[::1]` is up. The Express address stays `https://localhost:5241`.

    If Chrome policy `LoopbackNetworkBlockedForUrls` blocks loopback (the managed value is often `["*"]`; site settings say Apps on device are blocked by the administrator), skip the step. Express otherwise says the development environment failed to load and to check the PORT number. The skip message, and any failure message in that state, must name `LoopbackNetworkBlockedForUrls`. Read it from the policy JSON under `/etc/opt/chrome/policies` or `/etc/chromium/policies` (the same data as chrome://policy). Do not change the policy. Do not add a Chrome security flag.

    When localhost sideload is blocked, the real Express test is a private link, and only after the person approves it. The path is `npm run package`, then `dist.zip`, then Manage add-ons, then the listing, then Private link. A publisher profile is required first, and the logo must be 250x250. Do not create the publisher profile or the listing. That is a manual step. Ask, then wait for approval.

    Then ask `express-result`. A pass is recorded only when the panel rendered in Express, the feature was exercised, and a screenshot was saved with `session.mjs shot --kind express`. A failure or a timeout is recorded as that. Read [references/sideload.md](references/sideload.md) and [references/express-beta.md](references/express-beta.md).

12. **Listing and screenshots.** The same listing question, draft, and screenshot review as Preflight. Text and screenshots are shown before anything is written into the add-on. Nothing is submitted.

13. **Done.** `node scripts/session.mjs done --summary "..."`, then `node scripts/dashboard.mjs stop`. The summary says what was written, what was skipped, that the headless browser run used a stand-in, and whether the beta Express check passed, failed, or was skipped.

## References

- [references/session.md](references/session.md) — steps and questions
- [references/dashboard.md](references/dashboard.md) — the same dashboard and the same wait contract
- [references/feasibility.md](references/feasibility.md) — iframe, sandbox, unsupported
- [references/sideload.md](references/sideload.md) — trusting the dev CA for `https://localhost:5241`
- [references/express-beta.md](references/express-beta.md) — the optional real Express test, remote skip, and browser adapters
