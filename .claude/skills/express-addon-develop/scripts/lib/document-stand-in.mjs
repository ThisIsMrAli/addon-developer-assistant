/**
 * DOCUMENT STAND-IN
 * label: express-document-stand-in
 *
 * A small model of the Adobe Express document sandbox: a page, text, image, and shape nodes with
 * geometry, and the editor calls an add-on uses to place them. It is not Adobe Express.
 * `record` runs the add-on's own sandbox code against it in Node, and the audit loads the same file
 * in the browser stand-in, so the panel talks to the add-on's real sandbox functions.
 *
 * The rules it enforces are the documented ones:
 * - createImageContainer: "initialSize ... Must have the same aspect ratio as bitmapData." Express
 *   throws "Aspect ratio of initialSize must match aspect ratio of bitmapData to within 1%".
 * - createImageContainer after `await loadBitmapImage()` belongs in the afterAsyncCallback of
 *   keepContentActiveDuringAsync. An edit outside it is recorded. queueAsyncEdit was removed from the SDK.
 * - Only the documented surface exists (REFERENCE): editor, context, ItemList, Node, TextNode,
 *   MediaContainerNode, ArtboardNode, constants, colorUtils and fonts expose the members their
 *   reference pages list. Any other property is undefined, so calling it throws
 *   "TypeError: … is not a function", as Express does (NP11).
 * Text is measured as 0.55 × font size per character and 1.2 × font size per line.
 * This file has no imports, so a browser can load it as it is.
 */

export const STAND_IN_LABEL = "express-document-stand-in";
export const ASPECT_MESSAGE = "Aspect ratio of initialSize must match aspect ratio of bitmapData to within 1%";

const permissive = (name) => new Proxy(function stub() { return permissive(name); }, {
  get(target, key) {
    if (key === Symbol.toPrimitive) return () => name;
    if (key === "then") return undefined;
    if (key === Symbol.iterator) return function* empty() {};
    if (key === "toString" || key === "valueOf") return () => name;
    if (typeof key === "symbol") return undefined;
    return permissive(`${name}.${key}`);
  },
  apply() { return permissive(`${name}()`); }
});

/** Where the documented surface comes from. Every member below is in these pages; anything else is undefined, as in Express. */
export const REFERENCE = "https://developer.adobe.com/express/add-ons/docs/references/document-sandbox/document-apis";

/**
 * The enumerations and their members, as the Constants page and each enumeration page list them
 * (constants/overview.md, enumerations/*.md). A member that is not listed is undefined.
 */
export const DOCUMENTED_CONSTANTS = {
  ArrowHeadType: { none: 0, triangularFilled: 7, openTriangular: 11, circleFilled: 21, squareFilled: 22, circleHollow: 24, squareHollow: 25, verticalLine: 27 },
  BlendMode: { passThrough: 1, normal: 2, multiply: 3, darken: 4, colorBurn: 5, lighten: 6, screen: 7, colorDodge: 8, overlay: 9, softLight: 10, hardLight: 11, difference: 12, exclusion: 13, hue: 14, saturation: 15, color: 16, luminosity: 17, accumulate: 18 },
  CreateRenditionFormat: { png: "png", jpeg: "jpeg" },
  EditorEvent: { selectionChange: "selectionChange" },
  FillRule: { nonZero: 0, evenOdd: 1 },
  FillType: { color: "Color" },
  OrderedListNumbering: { numeric: 1, uppercaseAlpha: 2, lowercaseAlpha: 3, uppercaseRomanNum: 4, lowercaseRomanNum: 5, singleZeroPrefixNumeric: 7, doubleZeroPrefixNumeric: 8 },
  ParagraphListType: { none: 0, unordered: 1, ordered: 2 },
  ResizeBehavior: { contain: "contain", cover: "cover", proportional: "proportional" },
  SceneNodeType: { line: "Line", rectangle: "Rectangle", ellipse: "Ellipse", path: "Path", linkedAsset: "LinkedAsset", group: "Group", artboard: "ab:Artboard", polygon: "artgr:Polygon", artworkRoot: "ArtworkRoot", mediaContainer: "MediaContainer", imageRectangle: "ImageRectangle", unknownMediaRectangle: "UnknownMediaRectangle", page: "Page", complexShape: "ComplexShape", solidColorShape: "SolidColorShape", strokeShape: "StrokeShape", gridCell: "GridCell", gridLayout: "GridLayout", text: "Text" },
  StrokePosition: { center: 0, inside: 1, outside: 2 },
  StrokeType: { color: "Color" },
  TextAlignment: { left: 1, right: 2, center: 3, justifyLeft: 4 },
  TextLayout: { area: 1, autoHeight: 2, autoWidth: 3, circular: 4, magicFit: 5 },
  TextScriptStyle: { none: 0, superscript: 1, subscript: 2 },
  TextStyleSource: { beforeInsertionPoint: 0, afterInsertionPoint: 1, firstReplacedCharacter: 2 },
  VisualEffectType: { generativeTextEffects: "GenerativeTextEffects", outline: "Outline", shadow: "Shadow", shapeDecoration: "ShapeDecoration" }
};

/** Enumerations re-exported at the top level of express-document-sdk (constants/overview.md). */
const TOP_LEVEL_ENUMS = ["ArrowHeadType", "BlendMode", "EditorEvent", "FillRule", "FillType", "ResizeBehavior", "SceneNodeType", "StrokePosition", "StrokeType", "TextAlignment", "TextLayout", "TextScriptStyle", "VisualEffectType"];

function frozenConstants() {
  const out = {};
  for (const [name, members] of Object.entries(DOCUMENTED_CONSTANTS)) out[name] = Object.freeze({ ...members });
  return Object.freeze(out);
}

const TYPE = DOCUMENTED_CONSTANTS.SceneNodeType;

// Internal state lives on symbols, so add-on code reading `node._parent`, `node.fontSize` or
// `list._items` gets undefined, as it does in Express.
const PARENT = Symbol("parent");
const SIZE = Symbol("size");
const SCALE = Symbol("scale");
const ITEMS = Symbol("items");
const OWNER = Symbol("owner");
const DROP = Symbol("drop");
const FONT = Symbol("fontSize");
const TEXT = Symbol("text");
const BITMAP = Symbol("bitmap");
const MEDIA = Symbol("media");

/** Font size the stand-in measured for a text node (not an Express property). */
export function fontSizeOf(node) { return node ? node[FONT] : undefined; }
/** "text", "image", or "other", from the documented SceneNodeType values. */
export function kindOf(node) { return node?.type === TYPE.text ? "text" : node?.type === TYPE.mediaContainer ? "image" : "other"; }

export function createDocument({ width = 1920, height = 1080, background = false, existing = [] } = {}) {
  const log = { created: [], violations: [], errors: [], exposed: null, calls: [] };
  let active = 0;
  let afterAwait = false;
  let serial = 0;

  // ItemList (classes/item-list.md): length, first, last, append, clear, replace, insertBefore,
  // insertAfter, indexOf, item, [iterator], toArray, remove, moveBefore, moveAfter.
  class ItemList {
    constructor(owner) { this[OWNER] = owner; this[ITEMS] = []; }
    get length() { return this[ITEMS].length; }
    get first() { return this[ITEMS][0]; }
    get last() { return this[ITEMS][this[ITEMS].length - 1]; }
    item(index) { return this[ITEMS][index]; }
    indexOf(node) { return this[ITEMS].indexOf(node); }
    toArray() { return this[ITEMS].slice(); }
    [Symbol.iterator]() { return this[ITEMS].slice()[Symbol.iterator](); }
    append(...nodes) {
      for (const node of nodes) {
        if (!node || typeof node !== "object") throw new Error("append() needs a node.");
        const old = node[PARENT];
        if (old && old.children && old.children !== this) old.children[DROP](node);
        this[DROP](node);
        this[ITEMS].push(node);
        node[PARENT] = this[OWNER];
      }
    }
    insertAfter(node, after) { this[DROP](node); const at = this[ITEMS].indexOf(after); this[ITEMS].splice(at < 0 ? this[ITEMS].length : at + 1, 0, node); node[PARENT] = this[OWNER]; }
    insertBefore(node, before) { this[DROP](node); const at = this[ITEMS].indexOf(before); this[ITEMS].splice(at < 0 ? 0 : at, 0, node); node[PARENT] = this[OWNER]; }
    moveAfter(node, after) { this.insertAfter(node, after); }
    moveBefore(node, before) { this.insertBefore(node, before); }
    replace(oldNode, newNode) { const at = this[ITEMS].indexOf(oldNode); if (at < 0) return; this[ITEMS].splice(at, 1, newNode); oldNode[PARENT] = null; newNode[PARENT] = this[OWNER]; }
    remove(...nodes) { for (const node of nodes) { this[DROP](node); node[PARENT] = null; } }
    clear() { for (const node of this[ITEMS]) node[PARENT] = null; this[ITEMS] = []; }
    [DROP](node) { const at = this[ITEMS].indexOf(node); if (at >= 0) this[ITEMS].splice(at, 1); }
  }

  // Node (classes/node.md, visual-node.md): the accessors and methods listed there, nothing else.
  // rescaleProportionalToWidth/Height and a settable fontSize are not in the reference and are absent.
  class Node {
    constructor(type) {
      this.type = type;
      this.translation = { x: 0, y: 0 };
      this.rotation = 0;
      this.locked = false;
      this.opacity = 1;
      this.blendMode = DOCUMENTED_CONSTANTS.BlendMode.normal;
      this.addOnData = {};
      this[PARENT] = null;
      serial += 1;
      this.id = `${type}-${serial}`;
    }
    get parent() { return this[PARENT]; }
    get [SIZE]() { return { width: 0, height: 0 }; }
    get boundsLocal() { const size = this[SIZE]; return { x: 0, y: 0, width: size.width, height: size.height }; }
    get centerPointLocal() { const box = this.boundsLocal; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
    get topLeftLocal() { return { x: 0, y: 0 }; }
    get boundsInParent() { const box = this.boundsLocal; return { x: this.translation.x + box.x, y: this.translation.y + box.y, width: box.width, height: box.height }; }
    get rotationInScreen() { return this.rotation; }
    get transformMatrix() { return [1, 0, 0, 1, this.translation.x, this.translation.y]; }
    get visualRoot() { let at = this; while (at[PARENT] && at[PARENT].type !== TYPE.page) at = at[PARENT]; return at; }
    get allChildren() { return this.children ? this.children.toArray() : []; }
    get allDescendants() { const out = []; const visit = (node) => { for (const child of node.allChildren) { out.push(child); visit(child); } }; visit(this); return out; }
    get allTextContent() { return []; }
    boundsInNode() { return this.boundsLocal; }
    localPointInNode(point) { return point; }
    hasDescendant(node) { return this.allDescendants.includes(node); }
    async createRendition() { return []; }
    setPositionInParent(parentPoint, localRegistrationPoint) {
      const point = parentPoint || { x: 0, y: 0 };
      const ref = localRegistrationPoint || { x: 0, y: 0 };
      this.translation = { x: Number(point.x) - Number(ref.x || 0), y: Number(point.y) - Number(ref.y || 0) };
    }
    setRotationInParent(angle) { this.rotation = Number(angle) || 0; }
    removeFromParent() { const parent = this[PARENT]; if (parent && parent.children) parent.children.remove(this); }
    cloneInPlace() { throw new Error("cloneInPlace() is not modelled by the document stand-in."); }
    [SCALE]() {}
    // resize (node.md, ResizeOptions): width and/or height with contain/cover, or proportional with one of them.
    resize(geometry = {}) {
      const box = this.boundsLocal;
      if (!box.width || !box.height) return;
      const w = Number(geometry.width);
      const h = Number(geometry.height);
      let scale;
      if (Number.isFinite(w) && Number.isFinite(h)) scale = geometry.behavior === "cover" ? Math.max(w / box.width, h / box.height) : Math.min(w / box.width, h / box.height);
      else if (Number.isFinite(w)) scale = w / box.width;
      else if (Number.isFinite(h)) scale = h / box.height;
      else return;
      if (scale > 0 && Number.isFinite(scale)) this[SCALE](scale, geometry);
    }
  }

  class TextNode extends Node {
    constructor(text) {
      super(TYPE.text);
      this[TEXT] = String(text ?? "");
      this[FONT] = 100;
      const self = this;
      // TextContentModel (classes/text-content-model.md).
      this.fullContent = {
        id: `${this.id}-content`,
        get text() { return self[TEXT]; },
        set text(value) { self[TEXT] = String(value ?? ""); },
        get characterStyleRanges() { return [{ start: 0, length: self[TEXT].length, fontSize: self[FONT] }]; },
        set characterStyleRanges(ranges) { const size = Array.isArray(ranges) && ranges[0] && Number(ranges[0].fontSize); if (size > 0) self[FONT] = size; },
        get paragraphStyleRanges() { return [{ start: 0, length: self[TEXT].length }]; },
        set paragraphStyleRanges(_ranges) {},
        applyCharacterStyles(style = {}) { const size = Number(style.fontSize); if (size > 0) self[FONT] = size; },
        applyParagraphStyles() {},
        appendText(value) { self[TEXT] += String(value ?? ""); },
        insertText(value, index = 0) { const t = self[TEXT]; self[TEXT] = t.slice(0, index) + String(value ?? "") + t.slice(index); },
        replaceText(value, range = {}) { const t = self[TEXT]; const start = Number(range.start) || 0; self[TEXT] = t.slice(0, start) + String(value ?? "") + t.slice(start + (Number(range.length) || 0)); },
        deleteText(range = {}) { const t = self[TEXT]; const start = Number(range.start) || 0; self[TEXT] = t.slice(0, start) + t.slice(start + (Number(range.length) || 0)); },
        hasUnavailableFonts() { return false; }
      };
      this.textAlignment = DOCUMENTED_CONSTANTS.TextAlignment.left;
      this.layout = { type: DOCUMENTED_CONSTANTS.TextLayout.autoWidth };
      this.visualEffects = [];
      this.nextTextNode = undefined;
    }
    get text() { return this[TEXT]; }
    set text(value) { this[TEXT] = String(value ?? ""); }
    isStandaloneText() { return true; }
    isThreadedText() { return false; }
    get [SIZE]() {
      const lines = this[TEXT].split("\n");
      const longest = Math.max(1, ...lines.map((line) => line.length));
      return { width: 0.55 * this[FONT] * longest, height: 1.2 * this[FONT] * lines.length };
    }
    [SCALE](scale) { this[FONT] *= scale; }
  }

  class MediaContainerNode extends Node {
    constructor(w, h) { super(TYPE.mediaContainer); this[MEDIA] = { w, h }; }
    get [SIZE]() { return { width: this[MEDIA].w, height: this[MEDIA].h }; }
    get mediaRectangle() { return { width: this[MEDIA].w, height: this[MEDIA].h, type: TYPE.imageRectangle }; }
    get maskShape() { return { width: this[MEDIA].w, height: this[MEDIA].h, type: TYPE.rectangle }; }
    replaceMedia() {}
    [SCALE](scale) { this[MEDIA].w *= scale; this[MEDIA].h *= scale; }
  }

  class ShapeNode extends Node {
    constructor(type) { super(type); this.width = 100; this.height = 100; this.fill = null; this.stroke = null; }
    get [SIZE]() { return { width: Number(this.width) || 0, height: Number(this.height) || 0 }; }
    [SCALE](scale, geometry) {
      if (geometry && geometry.behavior !== "contain" && Number.isFinite(Number(geometry.width)) && Number.isFinite(Number(geometry.height))) {
        this.width = Number(geometry.width);
        this.height = Number(geometry.height);
        return;
      }
      this.width *= scale;
      this.height *= scale;
    }
  }

  class GroupNode extends Node {
    constructor() { super(TYPE.group); this.children = new ItemList(this); }
    get [SIZE]() {
      let right = 0;
      let bottom = 0;
      for (const child of this.children) { const box = child.boundsInParent; right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height); }
      return { width: right, height: bottom };
    }
  }

  // ArtboardNode (classes/artboard-node.md): children, fill, width, height and the VisualNode members.
  class ArtboardNode extends Node {
    constructor(w, h) { super(TYPE.artboard); this.width = w; this.height = h; this.children = new ItemList(this); this.fill = null; }
    get [SIZE]() { return { width: this.width, height: this.height }; }
  }

  const page = new ArtboardNode(width, height);
  // PageNode / ActivePageNode (classes/active-page-node.md): artboards, width, height, name.
  const pageNode = { type: TYPE.page, width, height, name: "Page 1", id: "page-1", addOnData: {} };
  pageNode.artboards = new ItemList(pageNode);
  pageNode.artboards.append(page);
  pageNode.parent = undefined;
  pageNode.removeFromParent = () => {};
  pageNode.hasDescendant = (node) => page === node || page.hasDescendant(node);
  if (background) {
    const back = new ShapeNode(TYPE.rectangle);
    back.width = width;
    back.height = height;
    back.locked = background === "unlocked" ? false : true;
    back.id = "background";
    page.children.append(back);
  }
  for (const item of existing) {
    const node = new ShapeNode(TYPE.rectangle);
    node.width = item.width;
    node.height = item.height;
    node.translation = { x: item.x, y: item.y };
    node.locked = Boolean(item.locked);
    node.id = item.id || "existing";
    page.children.append(node);
  }

  const track = (node) => { log.created.push(node); return node; };
  const pages = { first: pageNode, last: pageNode, length: 1, item: (index) => (index === 0 ? pageNode : undefined), indexOf: (node) => (node === pageNode ? 0 : -1), [Symbol.iterator]: () => [pageNode][Symbol.iterator](), toArray: () => [pageNode] };
  const documentRoot = { type: "ExpressRoot", id: "root", pages, addOnData: {} };
  // Editor / ExpressEditor (classes/editor.md, express-editor.md). queueAsyncEdit was removed from
  // the SDK (references/changelog.md, 2026-08-03), so it is absent here too.
  const context = {
    get insertionParent() { return page; },
    get currentPage() { return pageNode; },
    get selection() { return []; },
    get selectionIncludingNonEditable() { return []; },
    get hasSelection() { return false; },
    on() { return "handler-1"; },
    off() {}
  };
  const editor = {
    get context() { return context; },
    get documentRoot() { return documentRoot; },
    createText(text) { return track(new TextNode(text)); },
    createThreadedText(text) { return track(new TextNode(text)); },
    createRectangle() { return track(new ShapeNode(TYPE.rectangle)); },
    createEllipse() { const node = new ShapeNode(TYPE.ellipse); node.rx = 50; node.ry = 50; return track(node); },
    createLine() { return track(new ShapeNode(TYPE.line)); },
    createPath() { return track(new ShapeNode(TYPE.path)); },
    createGroup() { return track(new GroupNode()); },
    makeColorFill(color) { return { type: DOCUMENTED_CONSTANTS.FillType.color, color }; },
    makeStroke(options) { return { type: DOCUMENTED_CONSTANTS.StrokeType.color, ...(options || {}) }; },
    async loadBitmapImage(blob) {
      log.calls.push("loadBitmapImage");
      const size = await bitmapSize(blob);
      afterAwait = true;
      const bitmap = { width: size.width, height: size.height, async data() { return blob; } };
      Object.defineProperty(bitmap, BITMAP, { value: true });
      return bitmap;
    },
    createImageContainer(bitmap, options = {}) {
      if (!bitmap || !bitmap[BITMAP]) throw new Error("createImageContainer needs the BitmapImage that loadBitmapImage returned.");
      if (afterAwait && !active) log.violations.push("createImageContainer ran after await loadBitmapImage() outside keepContentActiveDuringAsync's afterAsyncCallback.");
      let w = bitmap.width;
      let h = bitmap.height;
      const size = options && options.initialSize;
      if (size) {
        const want = Number(size.width) / Number(size.height);
        const have = bitmap.width / bitmap.height;
        if (!(want > 0) || Math.abs(want - have) / have > 0.01) throw new Error(ASPECT_MESSAGE);
        w = Number(size.width);
        h = Number(size.height);
      }
      return track(new MediaContainerNode(w, h));
    },
    async keepContentActiveDuringAsync(_node, lambda, after) {
      if (typeof lambda === "function") {
        const before = log.created.length;
        await lambda();
        if (log.created.length > before) log.violations.push("The async lambda of keepContentActiveDuringAsync created document content. The Editor reference keeps edits in the afterAsyncCallback.");
      }
      if (typeof after === "function") {
        active += 1;
        try { after(); } finally { active -= 1; }
      }
    }
  };
  const constants = frozenConstants();
  // colorUtils (classes/color-utils.md): fromRGB, fromHex, toHex.
  const colorUtils = {
    fromRGB: (red, green, blue, alpha = 1) => (typeof red === "object" ? { alpha: 1, ...red } : { red, green, blue, alpha }),
    fromHex: (hex) => ({ hex: String(hex), red: 0, green: 0, blue: 0, alpha: 1 }),
    toHex: () => "#000000ff"
  };
  // Fonts (classes/fonts.md): fromPostscriptName.
  const fonts = {
    async fromPostscriptName(name) { return { postscriptName: String(name), availableForEditing: true, family: String(name), style: "Regular" }; }
  };
  const viewport = { bringIntoView() {}, fitToScreen() {} };
  const runtime = {
    type: "documentSandbox",
    exposeApi(api) { log.exposed = api; return api; },
    apiProxy: async () => permissive("panel")
  };
  const sandboxSdk = { instance: { runtime }, __standIn: STAND_IN_LABEL };
  const sdkExports = { editor, constants, Constants: constants, colorUtils, fonts, viewport };
  for (const name of TOP_LEVEL_ENUMS) sdkExports[name] = constants[name];
  return {
    label: STAND_IN_LABEL,
    page,
    editor,
    constants,
    colorUtils,
    fonts,
    runtime,
    log,
    modules: {
      "express-document-sdk": { ...sdkExports, default: { ...sdkExports } },
      "add-on-sdk-document-sandbox": { default: sandboxSdk, ...sandboxSdk }
    },
    permissive
  };
}

/** Width and height of a Blob, a File, or a test stand-in such as { width, height }. */
export async function bitmapSize(blob) {
  if (blob && Number(blob.width) > 0 && Number(blob.height) > 0) return { width: Number(blob.width), height: Number(blob.height) };
  if (blob && typeof globalThis.createImageBitmap === "function" && typeof blob.arrayBuffer === "function") {
    const bitmap = await globalThis.createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    if (typeof bitmap.close === "function") bitmap.close();
    return size;
  }
  if (blob && typeof blob.arrayBuffer === "function") {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
  }
  throw new Error("loadBitmapImage needs an image Blob.");
}

/**
 * Browser entry: one landscape page for the audit's stand-in.
 * `globalThis.__expressDocumentStandIn` is what the panel stand-in reads.
 */
export function installBrowserStandIn(options) {
  const doc = createDocument(options);
  globalThis.__expressDocumentStandIn = doc;
  return doc;
}
