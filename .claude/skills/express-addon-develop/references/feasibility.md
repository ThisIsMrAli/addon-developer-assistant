# Feasibility

`develop.mjs classify` reads the pages this session fetched. A missing page falls back to the cache and is labelled stale. If the architecture page is missing entirely, the feature is not classified.

The class is one of:

- **iframe.** The feature is panel UI: a field, a button, a label, a dialog. The architecture page calls the iframe runtime the user interface environment. Document APIs are not added there.
- **sandbox.** The feature changes the document (`createText`, `createRectangle`, the selection, a shape). The architecture page says those APIs are not available in the iframe. The add-on needs a `documentSandbox` entry. If it has none, nothing is written and the note says so.
- **unsupported.** The pages deny it. Network APIs such as `fetch()` are not available in the document sandbox. Host cookies, the host DOM, and a background page are outside both runtimes. No project file is changed.

The evidence field is a sentence copied from the page. It is not a paraphrase. The implementation cites that sentence in a comment. A class with no sentence is not used.

Spectrum Web Components stay the design preference while the implementation guide still says to prefer them. `swc-react` is preferred over React Spectrum when the same page says so. A javascript template that has no webpack does not gain one during the feature edit. The note records that the guide requires webpack for Spectrum Web Components.
