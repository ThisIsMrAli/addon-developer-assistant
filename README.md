# Adobe Express Add-on Developer Assistant

**From idea to Express add-on.** Describe the tool you want to build. Shape the plan, follow the build, and try a packaged add-on in Adobe Express.

[![Demo capture showing the QR add-on and its development dashboard.](site/demo.webp)](https://drive.google.com/file/d/1ev2h_zNWLxP5_Wcxg1FSXdD1MwDFhW5j/view?usp=sharing)

[Watch the demo](https://drive.google.com/file/d/1ev2h_zNWLxP5_Wcxg1FSXdD1MwDFhW5j/view?usp=sharing) · [Install](#install) · [How it works](#how-it-works)

## How it works

1. **Shape the idea.** Confirm the goal and the plan before project files are written.
2. **Build the add-on.** Use Adobe’s docs, select a template, and implement the feature with the right Express APIs.
3. **Check the result.** Verify the implementation, package it, and walk the panel in light and dark.
4. **Try and improve.** Load it in Express, share feedback with screenshots, and try the next build.


## What you get

- **Build on existing work.** Add a feature to a project you maintain, or start with a new add-on.
- **Follow every decision.** The local dashboard shows the plan, work in progress, captures, and feedback.
- **Prepare your listing.** Review draft marketplace copy and images before they are copied into your project.

The automated panel walk uses an SDK stand-in. Use Adobe Express to verify host behavior.

## Install

You’ll need Node.js 18 or newer and GitHub access to the private repository.

```bash
git clone https://github.com/ThisIsMrAli/addon-developer-assistant.git
cd addon-developer-assistant
node install-agents.mjs --global
```

Open a new chat in **Codex**, **Claude Code**, or **Cursor** with your project open. The installer also links supported tools such as Gemini CLI and Windsurf. Keep the checkout on disk so the links continue to work. Omit `--global` to link skills inside the checkout only.

> Use express-addon-develop to build an Express add-on that creates QR codes and adds them to the current design.

The installer links both Express skills in this checkout. Development uses the companion review scripts shipped here.

## Run from the terminal

```bash
npm run develop -- begin --dir /path/to/folder --goal "Add a caption field to the panel"
npm test
npm run test:box
```

Use a browser on the same machine for panel checks and listing captures. Set `CHROME_PATH` if needed. The optional develop beta step can open Express only after you choose Run.

See the [development workflow](.claude/skills/express-addon-develop/SKILL.md) and [companion review workflow](.claude/skills/express-addon-review/SKILL.md) for CLI steps.

## Share a private preview

The owner enables GitHub Pages deliberately. `.github/workflows/pages.yml` runs only when someone starts it by hand. It does not deploy on a push to main, and it does not run on a schedule.

The source repository stays private. It does not appear on a public GitHub profile, and nobody can clone it without being given access.

GitHub Pages has no signature check. A private repository hides the source. It does not hide a Pages site. The preview address is an unguessable path, with an optional expiry, which is as close as Pages can come to a presigned URL:

- The site root says “Not found” and does not name the project.
- The page and its presentation assets exist only under that path.
- Anyone with the address can open it until you rotate the path, or until the date passes and the next deploy removes it.
- An expired path is removed the next time the owner runs the Pages workflow. `noindex` asks search engines not to list the site. That is not access control.

Do not put secrets on the page, and do not post the address in public. Publishing Pages from a private repository needs GitHub Pro, Team, or Enterprise. This project is not published from a public repository.

```bash
node scripts/share-link.mjs                 # print the address and store it in Actions secrets
node scripts/share-link.mjs --days 30       # the same, and remove the path 30 days later
node scripts/share-link.mjs --rotate        # invalidate the current address
node scripts/share-link.mjs --publish       # also start a deploy
```

The address is written to `.share/link.json` on this computer and to Actions secrets. `.share/` is not committed. The command refuses to continue when the repository is not private.

## License

[MIT](LICENSE)
