import { DEV_PAGES, readPage } from "./docs-live.mjs";

const UI = /\b(button|panel|field|form|label|caption|input|dialog|toggle|slider|theme)\b/i;
const DOCUMENT = /\b(rectangle|artboard|selection|createText|createRectangle|shape|scenegraph|heading|headline|image|photo|picture)\b/i;
const SANDBOX_FETCH = /\bfetch\b/i;
const HOST = /\b(cookie|background|host dom|file system|filesystem|chrome:\/\/)\b/i;
const OAUTH = /\boauth\b|clientStorage|dropbox/i;

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
    return result("unsupported", architecture, "isolated from each other", "src/pages/guides/learn/platform-concepts/architecture.md", "The feature asks for host access the architecture page keeps outside both runtimes.", pages);
  }
  if (SANDBOX_FETCH.test(text) && /sandbox/i.test(text) && fetchSentence) {
    return result("unsupported", architecture, "fetch()", "src/pages/guides/learn/platform-concepts/architecture.md", "Network APIs are described as unavailable in the document sandbox.", pages);
  }

  const wantsText = /\b(heading|headline|createText|styled)\b/i.test(text) || (/\btext\b/i.test(text) && /\b(document|sandbox)\b/i.test(text));
  const wantsImage = /\b(image|photo|picture|addImage)\b/i.test(text);
  const wantsDocument = /\bdocument sandbox\b/i.test(text) || /\binto the document\b/i.test(text) || (DOCUMENT.test(text) && (/\b(document|canvas|artboard|sandbox)\b/i.test(text) || wantsText || wantsImage));
  const wantsUi = UI.test(text);

  if (wantsDocument && (wantsText || wantsImage || /\b(rectangle|shape|artboard)\b/i.test(text))) {
    const found = evidenceFor(pages, [
      wantsText ? "editor.createText()" : "",
      wantsImage ? "addImage()" : "",
      "text, images",
      "document sandbox"
    ].filter(Boolean));
    if (found) {
      return result("sandbox", found.text, found.needle, found.page, "The feature changes the document, so it uses the document sandbox APIs named in that sentence.", pages);
    }
  }
  if (OAUTH.test(text)) {
    const found = evidenceFor(pages, ["OAuth", "clientStorage"]);
    if (found) {
      return result("iframe", found.text, found.needle, found.page, "OAuth and client storage run in the iframe, and the manifest has to allow them.", pages);
    }
  }
  if (wantsUi && uiSentence && !wantsDocument) {
    return result("iframe", architecture, uiSentence.includes("user interface") ? "user interface environment" : "iframe runtime", "src/pages/guides/learn/platform-concepts/architecture.md", "The feature is panel UI. That runs in the iframe.", pages);
  }
  if (wantsUi && wantsDocument && sandboxSentence) {
    return result("sandbox", architecture, "document sandbox", "src/pages/guides/learn/platform-concepts/architecture.md", "The feature needs the document. The UI that triggers it can stay in the iframe, and the document call cannot.", pages);
  }
  if (uiSentence && !wantsDocument) {
    return result("iframe", architecture, "iframe runtime", "src/pages/guides/learn/platform-concepts/architecture.md", "Nothing in the feature needs the document APIs, so it stays in the iframe.", pages);
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

function result(kind, pageText, needle, page, summary, pages) {
  const evidence = sentenceWith(pageText, needle);
  if (!evidence) {
    return { class: null, summary: "The evidence sentence was not in the fetched page, so this was not classified.", evidence: "", page: "", docsLabel: pages.label || "" };
  }
  return {
    class: kind,
    summary: `${summary} Evidence: “${plainSentence(evidence).slice(0, 240)}”`,
    evidence,
    page,
    guide: Boolean(pages.guide && pages.guide.includes("Spectrum Web Components")),
    docsLabel: pages.label || ""
  };
}

function evidenceFor(pages, needles) {
  const sources = [
    ["src/pages/guides/learn/platform-concepts/architecture.md", pages.architecture],
    ["src/pages/guides/learn/platform-concepts/document-api.md", pages.document],
    ["src/pages/guides/build/design/implementation-guide.md", pages.guide]
  ];
  for (const needle of needles) {
    for (const [page, text] of sources) {
      if (sentenceWith(text, needle)) return { text, needle, page };
    }
  }
  return null;
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
  let sentence = source.slice(start + 1, end).replace(/\s+/g, " ").trim();
  if (/createText/.test(String(needle || "")) && /createRectangle\(\)/.test(sentence)) {
    sentence = sentence.replace(/^[\s\S]*?createRectangle\(\)\s*,?\s*/, "").trim();
  }
  return sentence;
}

/** The dashboard shows this sentence. Markdown and HTML from the doc page are not left in it. */
export function plainSentence(value) {
  return String(value || "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/`+/g, "")
    .replace(/•/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pagesFromDisk(out, docs) {
  const labels = new Map((docs?.pages || []).map((page) => [page.id, page.label]));
  const architectureId = DEV_PAGES[0];
  const guideId = DEV_PAGES[3];
  const architecture = readPage(out, architectureId);
  const guide = readPage(out, guideId);
  const document = readPage(out, DEV_PAGES[1]);
  const used = [labels.get(architectureId), labels.get(guideId), labels.get(DEV_PAGES[1])].filter(Boolean);
  const label = used.includes("failed") && !architecture ? "failed" : used.includes("stale") ? "stale" : used.includes("fresh") ? "fresh" : architecture ? "cache" : "failed";
  return { architecture, guide, document, label };
}
