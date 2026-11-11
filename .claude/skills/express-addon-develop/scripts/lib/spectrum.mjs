/**
 * Spectrum is the Express panel's component set, not a pair of form controls.
 * A button is a real action. Sections, choices, toggles, and color each have their own component.
 */

export const SPECTRUM_EXAMPLES = "Examples, not the whole set: sections are sp-tabs, a list of options is sp-picker or sp-menu, on/off is sp-switch, one of a few is sp-radio, a range is sp-slider, text is sp-textfield or sp-textarea, color is sp-color-area with sp-color-slider and sp-color-field, status is sp-status-light, a group of cards is sp-card, a long page of groups is sp-accordion. A real action, and only a real action, is sp-button. A plain button, input, select, or textarea is not done. An sp-button used as a tab or a menu item is not done. React still writes disabled={false} as a present attribute, and Spectrum treats a present disabled, pending, selected, or checked attribute as true. Omit the attribute when the value is false, and set the DOM property in an effect.";

export function spectrumHandoff(catalog = null) {
  const fetched = catalog?.components?.length
    ? `The full set was fetched from @spectrum-web-components/bundle@${catalog.version || "current"}: ${catalog.components.length} components, in ${catalog.markdown || catalog.file}. Use a tag from that file. Open its docs URL before using it. A tag that is not in the file is not a Spectrum component.`
    : "The Spectrum catalog was not fetched. Do not treat any short list as the whole set. Say that in the summary, and do not invent a tag.";
  return {
    api: "Spectrum Web Components, the fetched catalog",
    runtime: "iframe panel",
    note: `The panel uses Spectrum Web Components with the Express theme (sp-theme, system="express"). ${SPECTRUM_EXAMPLES} ${fetched} Do not swap Spectrum for Radix or plain HTML because a report names another library. An open sp-picker or sp-menu is a menu, including when Spectrum shows it as an overlay at 320px. It does not need a Close button.`
  };
}

function openings(markup, name) {
  return (String(markup || "").match(new RegExp(`<${name}\\b`, "gi")) || []).length;
}

function usedTags(markup) {
  return [...new Set([...String(markup || "").matchAll(/<(sp-[a-z0-9-]+)\b/gi)].map((match) => match[1].toLowerCase()))];
}

/** Problems when the design answer is Spectrum. `catalogTags` is the fetched set. Null means the fetch did not run. */
export function spectrumProblems(markup, catalogTags = null) {
  const html = String(markup || "");
  const problems = [];
  const used = usedTags(html);
  const known = catalogTags instanceof Set && catalogTags.size ? catalogTags : null;
  const controls = used.filter((tag) => tag !== "sp-theme" && (!known || known.has(tag)));
  if (!controls.length) {
    problems.push(known
      ? `The design is Spectrum. Use a component from the fetched catalog (${known.size} components). sp-theme alone is not a control.`
      : "The design is Spectrum. Use a Spectrum Web Component from the catalog. sp-theme alone is not a control, and a plain button does not count.");
  }
  if (known) {
    const unknown = used.filter((tag) => tag !== "sp-theme" && !known.has(tag));
    if (unknown.length) problems.push(`${unknown.join(", ")} is not in the fetched Spectrum catalog. Use a tag from that file.`);
  }
  const plain = ["button", "input", "select", "textarea"].filter((tag) => openings(html, tag));
  if (plain.length) problems.push(`Replace plain <${plain.join(">, <")}> with a Spectrum component from the catalog. A button used as a tab or a menu item is not done.`);
  const choices = openings(html, "sp-picker") + openings(html, "sp-menu") + openings(html, "sp-action-menu") + openings(html, "sp-tabs") + openings(html, "sp-radio-group") + openings(html, "sp-action-group") + openings(html, "sp-card");
  if (openings(html, "sp-button") + openings(html, "sp-action-button") >= 4 && !choices) {
    problems.push("Several sp-button elements are standing in for sections or a list of choices. Sections are sp-tabs. A list of options is sp-picker or sp-menu. sp-button is only a real action. Other patterns use the matching component in the fetched catalog.");
  }
  const color = openings(html, "sp-color-area") + openings(html, "sp-color-slider") + openings(html, "sp-color-field") + openings(html, "sp-color-wheel") + openings(html, "sp-swatch");
  if (/type\s*=\s*["']color["']/i.test(html) && !color) problems.push("Color uses the Spectrum color components in the catalog (sp-color-area, sp-color-slider, sp-color-field, sp-color-wheel, sp-swatch), not a plain color input.");
  if (/\b(?:disabled|pending|selected|checked)=\{false\}|\b(?:disabled|pending|selected|checked)=["']false["']/i.test(html)) {
    problems.push("Spectrum treats a present boolean attribute as true. disabled={false}, pending={false}, selected={false}, and checked={false} still turn the control on. Omit the attribute when the value is false, and set the DOM property from an effect.");
  }
  return problems;
}
