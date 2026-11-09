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
 *   keepContentActiveDuringAsync, or in queueAsyncEdit. An edit outside them is recorded.
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

function namedConstants() {
  const named = (keys) => Object.fromEntries(keys.map((key) => [key, key]));
  const base = {
    ResizeBehavior: named(["contain", "cover", "proportional", "fill"]),
    TextAlignment: named(["left", "right", "center", "justifyLeft"]),
    SceneNodeType: named(["text", "mediaContainer", "rectangle", "ellipse", "group", "artboard", "line", "path", "imageRectangle"]),
    BlendMode: named(["normal", "multiply", "screen"]),
    FillType: named(["color"]),
    StrokePosition: named(["center", "inside", "outside"]),
    TextType: named(["autoWidth", "autoHeight", "area", "path", "magicFit", "circular"])
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === "symbol") return undefined;
      return new Proxy({}, { get: (_t, inner) => (typeof inner === "symbol" ? undefined : String(inner)) });
    }
  });
}

export function createDocument({ width = 1920, height = 1080, background = false, existing = [] } = {}) {
  const log = { created: [], violations: [], errors: [], exposed: null, calls: [] };
  let active = 0;
  let afterAwait = false;

  class ItemList {
    constructor(owner) { this._owner = owner; this._items = []; }
    get length() { return this._items.length; }
    get first() { return this._items[0]; }
    get last() { return this._items[this._items.length - 1]; }
    item(index) { return this._items[index]; }
    indexOf(node) { return this._items.indexOf(node); }
    includes(node) { return this._items.includes(node); }
    toArray() { return this._items.slice(); }
    forEach(fn) { this._items.slice().forEach(fn); }
    map(fn) { return this._items.slice().map(fn); }
    filter(fn) { return this._items.slice().filter(fn); }
    [Symbol.iterator]() { return this._items.slice()[Symbol.iterator](); }
    append(...nodes) {
      for (const node of nodes) {
        if (!node || typeof node !== "object") throw new Error("append() needs a node.");
        if (node.parent && node.parent.children && node.parent.children !== this) node.parent.children._drop(node);
        this._drop(node);
        this._items.push(node);
        node._parent = this._owner;
      }
    }
    insertAfter(node, after) { this._drop(node); const at = this._items.indexOf(after); this._items.splice(at < 0 ? this._items.length : at + 1, 0, node); node._parent = this._owner; }
    insertBefore(node, before) { this._drop(node); const at = this._items.indexOf(before); this._items.splice(at < 0 ? 0 : at, 0, node); node._parent = this._owner; }
    remove(...nodes) { for (const node of nodes) { this._drop(node); node._parent = null; } }
    clear() { for (const node of this._items) node._parent = null; this._items = []; }
    _drop(node) { const at = this._items.indexOf(node); if (at >= 0) this._items.splice(at, 1); }
  }

  class Node {
    constructor(type) {
      this.type = type;
      this.translation = { x: 0, y: 0 };
      this.rotation = 0;
      this.locked = false;
      this.opacity = 1;
      this._parent = null;
      this.id = `${type}-${log.created.length + 1}`;
    }
    get parent() { return this._parent; }
    get _size() { return { width: 0, height: 0 }; }
    get boundsLocal() { const size = this._size; return { x: 0, y: 0, width: size.width, height: size.height }; }
    get centerPointLocal() { const box = this.boundsLocal; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
    get topLeftLocal() { return { x: 0, y: 0 }; }
    get boundsInParent() { const box = this.boundsLocal; return { x: this.translation.x + box.x, y: this.translation.y + box.y, width: box.width, height: box.height }; }
    setPositionInParent(parentPoint, localRegistrationPoint) {
      const point = parentPoint || { x: 0, y: 0 };
      const ref = localRegistrationPoint || { x: 0, y: 0 };
      this.translation = { x: Number(point.x) - Number(ref.x || 0), y: Number(point.y) - Number(ref.y || 0) };
    }
    removeFromParent() { if (this._parent && this._parent.children) this._parent.children.remove(this); }
    _scale() {}
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
      if (scale > 0 && Number.isFinite(scale)) this._scale(scale, geometry);
    }
    rescaleProportionalToWidth(w) { this.resize({ width: w }); }
    rescaleProportionalToHeight(h) { this.resize({ height: h }); }
  }

  class TextNode extends Node {
    constructor(text) {
      super("text");
      this._text = String(text ?? "");
      this.fontSize = 100;
      const self = this;
      this.fullContent = {
        get text() { return self._text; },
        set text(value) { self._text = String(value ?? ""); },
        get characterStyleRanges() { return [{ start: 0, length: self._text.length, fontSize: self.fontSize }]; },
        set characterStyleRanges(ranges) { const size = Array.isArray(ranges) && ranges[0] && Number(ranges[0].fontSize); if (size > 0) self.fontSize = size; },
        applyCharacterStyles(style = {}) { const size = Number(style.fontSize); if (size > 0) self.fontSize = size; },
        applyParagraphStyles() {},
        paragraphStyleRanges: []
      };
      this.textAlignment = "left";
    }
    get text() { return this._text; }
    set text(value) { this._text = String(value ?? ""); }
    get _size() {
      const lines = this._text.split("\n");
      const longest = Math.max(1, ...lines.map((line) => line.length));
      return { width: 0.55 * this.fontSize * longest, height: 1.2 * this.fontSize * lines.length };
    }
    _scale(scale) { this.fontSize *= scale; }
  }

  class MediaContainerNode extends Node {
    constructor(w, h) { super("mediaContainer"); this._w = w; this._h = h; }
    get _size() { return { width: this._w, height: this._h }; }
    get mediaRectangle() { return { width: this._w, height: this._h }; }
    _scale(scale) { this._w *= scale; this._h *= scale; }
  }

  class ShapeNode extends Node {
    constructor(type) { super(type); this.width = 100; this.height = 100; this.fill = null; this.stroke = null; }
    get _size() { return { width: Number(this.width) || 0, height: Number(this.height) || 0 }; }
    _scale(scale, geometry) {
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
    constructor() { super("group"); this.children = new ItemList(this); }
    get _size() {
      let right = 0;
      let bottom = 0;
      for (const child of this.children) { const box = child.boundsInParent; right = Math.max(right, box.x + box.width); bottom = Math.max(bottom, box.y + box.height); }
      return { width: right, height: bottom };
    }
  }

  class ArtboardNode extends Node {
    constructor(w, h) { super("artboard"); this.width = w; this.height = h; this.children = new ItemList(this); this.fill = null; }
    get _size() { return { width: this.width, height: this.height }; }
  }

  const page = new ArtboardNode(width, height);
  const pageNode = { type: "page", width, height, artboards: new ItemList(null), name: "Page 1" };
  pageNode.artboards.append(page);
  page._parent = pageNode;
  if (background) {
    const back = new ShapeNode("rectangle");
    back.width = width;
    back.height = height;
    back.locked = background === "unlocked" ? false : true;
    back.id = "background";
    page.children.append(back);
  }
  for (const item of existing) {
    const node = new ShapeNode("rectangle");
    node.width = item.width;
    node.height = item.height;
    node.translation = { x: item.x, y: item.y };
    node.id = item.id || "existing";
    page.children.append(node);
  }

  const track = (node) => { log.created.push(node); return node; };
  const editor = {
    context: {
      get insertionParent() { return page; },
      get currentPage() { return pageNode; },
      get selection() { return []; },
      get hasSelection() { return false; },
      get documentRoot() { return editor.documentRoot; }
    },
    documentRoot: { pages: { first: pageNode, length: 1, item: () => pageNode, [Symbol.iterator]: () => [pageNode][Symbol.iterator](), toArray: () => [pageNode] } },
    createText(text) { return track(new TextNode(text)); },
    createRectangle() { return track(new ShapeNode("rectangle")); },
    createEllipse() { const node = new ShapeNode("ellipse"); node.rx = 50; node.ry = 50; return track(node); },
    createLine() { return track(new ShapeNode("line")); },
    createPath() { return track(new ShapeNode("path")); },
    createGroup() { return track(new GroupNode()); },
    makeColorFill(color) { return { type: "color", color }; },
    makeStroke(options) { return { type: "stroke", ...(options || {}) }; },
    async loadBitmapImage(blob) {
      log.calls.push("loadBitmapImage");
      const size = await bitmapSize(blob);
      afterAwait = true;
      return { width: size.width, height: size.height, _bitmap: true };
    },
    createImageContainer(bitmap, options = {}) {
      if (!bitmap || !bitmap._bitmap) throw new Error("createImageContainer needs the BitmapImage that loadBitmapImage returned.");
      if (afterAwait && !active) log.violations.push("createImageContainer ran after await loadBitmapImage() outside keepContentActiveDuringAsync's afterAsyncCallback or queueAsyncEdit.");
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
    async queueAsyncEdit(callback) {
      active += 1;
      try { return await callback(); } finally { active -= 1; }
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
  const editorProxy = new Proxy(editor, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === "symbol") return undefined;
      return permissive(`editor.${String(key)}`);
    }
  });
  const constants = namedConstants();
  const colorUtils = {
    fromRGB: (red, green, blue, alpha = 1) => (typeof red === "object" ? { alpha: 1, ...red } : { red, green, blue, alpha }),
    fromHex: (hex) => ({ hex: String(hex), red: 0, green: 0, blue: 0, alpha: 1 }),
    toHex: () => "#000000ff"
  };
  const fonts = new Proxy({
    async fromPostscriptName(name) { return { postscriptName: String(name), availableForEditing: true, family: String(name), style: "Regular" }; }
  }, { get: (target, key) => (key in target ? target[key] : typeof key === "symbol" ? undefined : permissive(`fonts.${String(key)}`)) });
  const runtime = {
    type: "documentSandbox",
    exposeApi(api) { log.exposed = api; return api; },
    apiProxy: async () => permissive("panel")
  };
  const sandboxSdk = { instance: { runtime }, __standIn: STAND_IN_LABEL };
  return {
    label: STAND_IN_LABEL,
    page,
    editor: editorProxy,
    constants,
    colorUtils,
    fonts,
    runtime,
    log,
    modules: {
      "express-document-sdk": { editor: editorProxy, constants, colorUtils, fonts, default: { editor: editorProxy, constants, colorUtils, fonts } },
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
