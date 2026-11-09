# Dashboard

The develop session opens Preflight's dashboard. Same server, same token in `?t=`, same Host check, same `wait`.

`node scripts/dashboard.mjs start` prints `{ ok, url }`. `server.json` is mode `0600`. The page binds to `127.0.0.1`. If it cannot start, the command returns `ok: false` and `fallback: "chat"`. Set chat mode and continue.

## What the page shows for a build

The step rail is the develop list: `docs`, `origin`, `template`, `feasibility`, `design`, `implement`, `build`, `package`, `audit`, `express`, `listing`, `done`.

`express` is immediately before `listing`. It is marked Optional and BETA. While it is still pending, it stays on the rail. The beta question and, after a local run, the result buttons are ordinary dashboard questions. Chat mode asks them with AskQuestion instead.

When docs have been fetched, a pill reads `Docs N fresh, N stale, N failed`. A stale page is a cached copy. A failed page has no copy. Do not describe either as fresh.

Questions use the same buttons. Between `ask` and `wait`, write nothing to the user.

`wait` defaults to 25 seconds and caps at 110. Run it again while the status is `pending`. A `server-down` status is the point to use AskQuestion.
