/**
 * Offline stand-in for the template registry and a failed Adobe doc fetch.
 * Template names exist only in this fixture, which is the text the parser reads.
 */
const constants = [
  'export const WITH_DOCUMENT_SANDBOX = "with-document-sandbox";',
  "export const AVAILABLE_ADD_ON_TEMPLATES = [",
  '  "javascript",',
  '  "swc-javascript",',
  "  `javascript-${" + "WITH_DOCUMENT_SANDBOX}`,",
  "];",
  ""
].join("\n");

globalThis.fetch = async (input) => {
  const href = String(input?.url || input);
  if (href.includes("registry.npmjs.org")) return json({ version: "0.0.0-test" });
  if (href.includes("constants.ts")) return text(constants);
  if (href.includes("api.github.com")) {
    return json([
      { type: "dir", name: "javascript" },
      { type: "dir", name: "swc-javascript" },
      { type: "dir", name: "javascript-with-document-sandbox" },
      { type: "file", name: "README.md" }
    ]);
  }
  if (href.includes("AdobeDocs")) throw new Error("network called");
  throw new Error(`unexpected fetch ${href}`);
};

function json(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function text(body) {
  return { ok: true, status: 200, text: async () => body };
}
