# BETA: a real test in Adobe Express

Asked after the headless audit, on the dashboard or in chat: "Run a real test in Adobe Express (beta)?" Skip is the default and the recommended option. Skip goes straight to the listing and the screenshots.

Run does four things, in order:

1. Trust the dev CA, as [sideload.md](sideload.md) describes, and start the add-on's dev server. The only origin that counts is `https://localhost:5241`. The certificate check uses Node's default verification. It never sets `NODE_TLS_REJECT_UNAUTHORIZED` and never uses `--ignore-certificate-errors`. The server from `ccweb-add-on-scripts` binds `[::1]:5241`. The check probes `[::1]` and `127.0.0.1` and reports which one is listening. Connecting the certificate check to the address that is actually listening does not change the Express address away from `localhost`.
2. Open a visible browser at `https://new.express.adobe.com`. The person signs in. This skill never reads or types a password, a code, or a cookie.
3. Guide the clicks: Add-on Development, Your add-ons, Add-on testing, connect to `https://localhost:5241`, Allow the local-network prompt, launch from In development, exercise the feature, capture a screenshot.
4. Ask `express-result`. The buttons are: the panel rendered and the feature was exercised; it failed or timed out; stop.

A pass is recorded only when the panel rendered in Express, the feature was exercised, and a screenshot with kind `express` is on the session. A failure, a timeout, or a missing screenshot stays a non-pass.

## Remote machines

A cloud agent, an SSH session, or a container skips the step and records the reason. Nothing is launched and the dev CA is not installed. `EXPRESS_DEVELOP_REMOTE=1` forces that skip. `EXPRESS_DEVELOP_REMOTE=0` is the test override that lets a mocked launch run on a remote machine. A mock still sets `expressPass` to false.

Chrome policy `LoopbackNetworkBlockedForUrls` is a separate skip. When the managed JSON under `/etc/opt/chrome/policies` or `/etc/chromium/policies` blocks loopback, the skip says so, and a failure in that state names the same policy. The skill does not edit the policy and does not add a Chrome security flag.

When that policy blocks localhost, the real Express test is a private link, and only after the person approves it. Run `npm run package`, then `dist.zip`, then Manage add-ons, then the listing, then Private link. A publisher profile is required first, and the logo must be 250x250. Do not create the publisher profile or the listing. That is a manual step. The page is [private-dist.md](../../express-addon-review/references/live/src/pages/guides/build/distribute/private-dist.md).

This repository's cloud-agent VM is remote. A run from that VM must not be called a real Express pass.

## Browser adapters

Checked 2026-11-09. The skill detects one adapter. It does not assume one.

| Adapter | Selected when | Invocation | Status |
| --- | --- | --- | --- |
| Cursor Browser | `CURSOR_AGENT=1` and `CURSOR_BROWSER_TOOL` is not `0`, and the machine is not remote | The agent uses Cursor's Browser tool. There is no shell binary. | Verified from the docs below. The skill asks the agent to navigate to Express. It does not spawn a command. |
| Local Chrome or Edge | Cursor's tool is not exposed, and `CHROME_PATH` or a browser on `PATH` exists | A visible window, persistent profile `~/.config/express-addon-develop/chrome-profile`, URL `https://new.express.adobe.com`. No `--headless`. | Verified as a local process this skill can start. |
| Checklist only | No Cursor tool and no local browser | The dashboard buttons, and the person opens Express. | The fallback. |
| Claude Code Chrome | Never selected by this skill | `claude --chrome`, `/chrome`, and `@browser` in VS Code are how a person connects Claude Code. | Verified as Claude's own startup path. Not verified as a command this skill can run inside an existing session. |
| Codex | Never selected by this skill | No CLI browser command was found. | Unverified. Computer use is an API, not a Codex CLI command. |

Sources:

- Cursor Browser, <https://cursor.com/docs/agent/tools/browser>. "Agent can control a web browser to test applications, audit accessibility, convert designs into code, and more." The page lists tools for visiting URLs, clicking, typing, and screenshots, and shows `@browser` in prompts. "You can use Browser without installing or configuring any external tools." The raw URL named in <https://cursor.com/llms.txt> (`/docs/agent/tools/browser.md`) returned 404 on this date; the HTML page was read.
- Claude Code, <https://code.claude.com/docs/en/chrome>. "Start Claude Code with the `--chrome` flag" and the command shown is `claude --chrome`. "Run `/chrome`" to manage the connection. In VS Code, `@browser` connects the session. The page does not document a Node or shell call that a skill, already running inside a session, can use to open one URL. Fallback: local Chrome or Edge, plus the checklist.
- Codex CLI, <https://developers.openai.com/codex/cli>. The page describes a terminal agent that inspects a repository and runs commands. No browser-launch command is documented there.
- OpenAI computer use, <https://developers.openai.com/api/docs/guides/tools-computer-use>. "Use `BrowserToolset`. Your driver exposes selected operations as function tools." That is an API an application hosts. It is not a Codex CLI command. Unverified for this skill. Fallback: local Chrome or Edge, plus the checklist.

`EXPRESS_DEVELOP_MOCK_LAUNCH=1` records the launch spec and does not start Chrome, apt, or the dev server. Tests use it. It is not an Express pass.
