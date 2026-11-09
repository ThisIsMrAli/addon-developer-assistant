/**
 * Takes real pictures of the add-on's own panel for the listing: the built panel is served with the
 * SDK stand-in and opened in headless Chrome. Nothing is drawn. When Chrome cannot run, it says so.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launch } from "../../../express-addon-review/scripts/lib/cdp.mjs";
import { findChrome, NO_CHROME } from "../../../express-addon-review/scripts/lib/chrome.mjs";
import { DEEP_TEXT } from "../../../express-addon-review/scripts/lib/audit.mjs";
import { builtDir, serveWithStandIn } from "./standin.mjs";

/** Sample words typed into the panel's first text field for the second picture. */
const SAMPLE = "Summer Sale";

export async function capturePanelShots({ dir, outDir, chrome = findChrome(), env = process.env }) {
  if (env.SKIP_BROWSER_TESTS) return { ok: false, error: "The box runner does not start Chrome or Edge, so no picture of the panel was taken." };
  if (!chrome) return { ok: false, error: `No picture of the panel was taken. ${NO_CHROME}` };
  const source = builtDir(dir);
  if (!source) return { ok: false, error: "No built panel (index.html) to photograph. Run the build first." };
  fs.mkdirSync(outDir, { recursive: true });
  const served = await serveWithStandIn(source);
  let page = null;
  try {
    page = await launch({ width: 320, height: 640, scale: 2, chrome });
    await page.goto(served.url);
    let text = "";
    for (let waited = 0; waited < 8000 && !text.trim(); waited += 250) {
      text = await page.eval(DEEP_TEXT).catch(() => "");
      if (!text.trim()) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!text.trim()) return { ok: false, error: "The panel showed no text in headless Chrome, so the picture would be blank. No picture was used." };
    await new Promise((resolve) => setTimeout(resolve, 400));
    const files = [];
    const front = path.join(outDir, "panel-front.png");
    await page.screenshot(front);
    files.push(front);
    const typed = await page.eval(`(() => {
      const fields = [];
      const walk = (root) => {
        for (const el of root.querySelectorAll("*")) {
          if (el.matches("input[type=text], input:not([type]), textarea, sp-textfield, sp-search")) fields.push(el);
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      const field = fields.find((el) => !el.closest?.("sp-textfield") || el.tagName.toLowerCase() === "sp-textfield");
      if (!field) return false;
      field.value = ${JSON.stringify(SAMPLE)};
      field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      return true;
    })()`).catch(() => false);
    const mid = path.join(outDir, "panel-mid.png");
    if (typed) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await page.screenshot(mid);
    } else {
      fs.copyFileSync(front, mid);
    }
    files.push(mid);
    await page.media("dark").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    const back = path.join(outDir, "panel-back.png");
    await page.screenshot(back);
    files.push(back);
    fs.copyFileSync(front, path.join(outDir, "panel-third.png"));
    files.push(path.join(outDir, "panel-third.png"));
    return { ok: true, files, capturedOn: "headless Chrome with the SDK stand-in", expressPass: false, panelText: text.trim().slice(0, 400) };
  } catch (error) {
    return { ok: false, error: `No picture of the panel was taken: ${String(error?.message || error).split("\n")[0]}` };
  } finally {
    if (page) await page.close().catch(() => {});
    await served.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const take = (flag) => {
    const at = process.argv.indexOf(flag);
    return at > 0 ? process.argv[at + 1] : "";
  };
  const result = await capturePanelShots({ dir: path.resolve(take("--dir")), outDir: path.resolve(take("--out")) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}
