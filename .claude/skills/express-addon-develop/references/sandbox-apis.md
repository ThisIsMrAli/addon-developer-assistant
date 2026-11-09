# Document sandbox APIs the snippet uses

Every Express call in the handoff snippet (`TEXT_INSIDE_PAGE` in `scripts/lib/implement.mjs`), checked against Adobe's reference. The document stand-in (`scripts/lib/document-stand-in.mjs`) exposes these members and the other members the same pages list. Anything else is undefined, so a call to it throws `TypeError: … is not a function`, as in Express.

Reference root: https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis (source: AdobeDocs/express-add-ons-docs `src/pages/references/document-sandbox/document-apis/`, checked 2026-11-09 at commit 3f85ea24).

| Call | Reference |
|---|---|
| `import { editor, constants } from "express-document-sdk"` | https://developer.adobe.com/express/add-ons/docs/guides/learn/fundamentals/document-sandbox-constants |
| `addOnSandboxSdk.instance.runtime.exposeApi()` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/communication/ |
| `editor.context.insertionParent` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/context |
| `editor.createText(text)` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/editor |
| `editor.loadBitmapImage(blob)` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/editor |
| `editor.keepContentActiveDuringAsync(node, async () => {}, after)` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/editor |
| `editor.createImageContainer(bitmap, { initialSize })` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/editor |
| `bitmap.width`, `bitmap.height` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/bitmap-image |
| `page.children.append()`, `for … of page.children` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/item-list |
| `page.width`, `page.height`, `page.id`, `page.children` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/artboard-node |
| `node.fullContent.applyCharacterStyles(styles, range)` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/standalone-text-node and https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/text-content-model |
| `node.boundsLocal`, `node.centerPointLocal`, `node.boundsInParent`, `node.parent`, `node.locked`, `node.id` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/node |
| `node.setPositionInParent(point, registration)` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/node |
| `node.removeFromParent()` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/node |
| `node.resize({ width, height, behavior, avoidScalingVisualDetailsIfPossible })` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/classes/node, https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/type-aliases/resize-options, https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/interfaces/resize-using-width-options |
| `constants.ResizeBehavior.contain` | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/enumerations/resize-behavior |
| `node.type` compared with `constants.SceneNodeType` values (`"Text"`, `"MediaContainer"`) | https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis/enumerations/scene-node-type |

## Not available

- `editor.queueAsyncEdit()`: removed from the SDK. Adobe changelog 2026-08-03: "Deprecated APIs (`queueAsyncEdit`, `PageNode.artboards`, …) are removed from the SDK" (https://developer.adobe.com/express/add-ons/docs/references/changelog). Use `keepContentActiveDuringAsync`.
- `node.fontSize`, `node.rescaleProportionalToWidth()`, `ItemList.forEach/map/filter/includes`, `ResizeBehavior.fill`: not in the reference.
- JavaScript built-ins newer than the engine. The document sandbox runs on QuickJS (https://developer.adobe.com/express/add-ons/docs/guides/learn/platform-concepts/architecture). Its Web APIs are the console methods (https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/web/), and the timer methods were removed (changelog). Heading Image 1.0.5 threw "not a function" in real Express on `slots.at(-1)` (NP11). QuickJS added `Array.prototype.at` in its 2023-12-09 release (https://github.com/bellard/quickjs/blob/master/Changelog), so the engine predates that release. `record` removes everything QuickJS added in or after it before it runs the code, and code-scan names each use (`scripts/lib/sandbox-engine.mjs`): `Array/String/TypedArray.prototype.at`, `findLast`, `findLastIndex`, `toSorted`, `toReversed`, `toSpliced`, `with`, `isWellFormed`, `toWellFormed`, `Object.hasOwn`, `Object.groupBy`, `Map.groupBy`, `Promise.withResolvers`, `Promise.try`, `Error.isError`, `RegExp.escape`, `Math.sumPrecise`, `structuredClone`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `fetch`, `WeakRef`, `FinalizationRegistry`. `String.prototype.replaceAll` is removed as well: QuickJS added it in 2020, but the Express sandbox has not been shown to provide it, and a Node run must not hide that the way it hid `.at`. Older built-ins stay: `??`, `?.`, spread, `Set`, `find`, `flat`, `flatMap`.
