import { DEV_PAGES, readPage } from "./docs-live.mjs";

const UI = /\b(button|panel|field|form|label|caption|input|dialog|toggle|slider|theme)\b/i;
const DOCUMENT = /\b(rectangle|artboard|selection|createText|createRectangle|shape|scenegraph)\b/i;
const SANDBOX_FETCH = /\bfetch\b/i;
const HOST = /\b(cookie|background|host dom|file system|filesystem|chrome:\/\/)\b/i;

/**
 * Classify one feature. A class is returned only when the page text contains the sentence used as evidence.
 * Needles that are absent from the fetch are ignored.
 */
export function classifyFeature(feature, pages) {
  const text = String(feature || "");
  const architecture = pages.architecture || "";
  const guide = pages.guide || "";
  if (!architecture.trim()) {
    return {
      class: null,
      summary: "The architecture page is not available, so the feature was not classified.",
      evidence: "",
      page: "",
      docsLabel: pages.label || "failed"
    };
  }

  const uiSentence = sentenceWith(architecture, "user interface environment") || sentenceWith(architecture, "iframe runtime");
  const sandboxSentence = sentenceWith(architecture, "Document APIs directly from the iframe runtime") || sentenceWith(architecture, "document sandbox");
  const fetchSentence = sentenceWith(architecture, "fetch()");
  const guideSentence = sentenceWith(guide, "Spectrum Web Components");

  if (HOST.test(text) && sentenceWith(architecture, "isolated from each other")) {
    return result("unsupported", architecture, "isolated from each other", "The feature asks for host access the architecture page keeps outside both runtimes.", pages);
  }
  if (SANDBOX_FETCH.test(text) && /sandbox/i.test(text) && fetchSentence) {
    return result("unsupported", architecture, "fetch()", "Network APIs are described as unavailable in the document sandbox.", pages);
  }

  const wantsDocument = DOCUMENT.test(text);
  const wantsUi = UI.test(text);
  if (wantsDocument && sandboxSentence && !wantsUi) {
    return result("sandbox", architecture, sandboxSentence.includes("Document APIs") ? "Document APIs directly from the iframe runtime" : "document sandbox", "The feature changes the document. Those APIs are not in the iframe runtime.", pages);
  }
  if (wantsUi && uiSentence && !wantsDocument) {
    return result("iframe", architecture, uiSentence.includes("user interface") ? "user interface environment" : "iframe runtime", "The feature is panel UI. That runs in the iframe.", pages);
  }
  if (wantsUi && wantsDocument && sandboxSentence) {
    return result("sandbox", architecture, "document sandbox", "The feature needs the document. The UI that triggers it can stay in the iframe, and the document call cannot.", pages);
  }
  if (uiSentence && !wantsDocument) {
    return result("iframe", architecture, "iframe runtime", "Nothing in the feature needs the document APIs, so it stays in the iframe.", pages);
  }
  return {
    class: "unsupported",
    summary: "The fetched pages do not show a supported place for this feature.",
    evidence: "",
    page: "src/pages/guides/learn/platform-concepts/architecture.md",
    guide: Boolean(guideSentence),
    docsLabel: pages.label || ""
  };
}

function result(kind, pageText, needle, summary, pages) {
  const evidence = sentenceWith(pageText, needle);
  if (!evidence) {
    return { class: null, summary: "The evidence sentence was not in the fetched page, so this was not classified.", evidence: "", page: "", docsLabel: pages.label || "" };
  }
  return {
    class: kind,
    summary: `${summary} Evidence: “${evidence.slice(0, 240)}”`,
    evidence,
    page: "src/pages/guides/learn/platform-concepts/architecture.md",
    guide: Boolean(pages.guide && pages.guide.includes("Spectrum Web Components")),
    docsLabel: pages.label || ""
  };
}

export function sentenceWith(text, needle) {
  const source = String(text || "");
  const at = source.toLowerCase().indexOf(String(needle || "").toLowerCase());
  if (at < 0) return "";
  const before = source.lastIndexOf("\n", at);
  const start = Math.max(source.lastIndexOf(".", at - 1), before);
  const endDot = source.indexOf(".", at + needle.length);
  const endLine = source.indexOf("\n", at + needle.length);
  let end = source.length;
  if (endDot >= 0) end = Math.min(end, endDot + 1);
  if (endLine >= 0) end = Math.min(end, endLine);
  return source.slice(start + 1, end).replace(/\s+/g, " ").trim();
}

export function pagesFromDisk(out, docs) {
  const labels = new Map((docs?.pages || []).map((page) => [page.id, page.label]));
  const architectureId = DEV_PAGES[0];
  const guideId = DEV_PAGES[3];
  const architecture = readPage(out, architectureId);
  const guide = readPage(out, guideId);
  const used = [labels.get(architectureId), labels.get(guideId)].filter(Boolean);
  const label = used.includes("failed") && !architecture ? "failed" : used.includes("stale") ? "stale" : used.includes("fresh") ? "fresh" : architecture ? "cache" : "failed";
  return { architecture, guide, label };
}
