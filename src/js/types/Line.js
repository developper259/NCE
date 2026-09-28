class LineNode {
  constructor(text = "") {
    this.text = text;
    this.textVersion = 0;
    this.positionIndex = null;
    this.tokensVersion = 0;
    this.tokens = null;
    this.isDirty = false;
    this.isHighlight = false;
    this.state = null;
    this.diffState = null;
    this.diffVersion = 0;
    this._diffSegments = [];
  }

  get diffSegments() {
    return this._diffSegments;
  }

  set diffSegments(segments) {
    const next = Array.isArray(segments) ? segments : [];
    if (this._diffSegments === next) return;
    this._diffSegments = next;
    this.diffVersion = (this.diffVersion || 0) + 1;
  }

  setText(text, edit = null) {
    if (this.text === text) {
      this.isDirty = true;
      this.isHighlight = false;
      return;
    }
    const previousIndex = this.positionIndex;
    this.text = text;
    this.textVersion++;
    if (
      previousIndex &&
      edit &&
      typeof previousIndex.applyAsciiEdit === "function" &&
      previousIndex.applyAsciiEdit(text, edit.start, edit.end, edit.text)
    ) {
      previousIndex.textVersion = this.textVersion;
      this.positionIndex = previousIndex;
    } else {
      this.positionIndex = null;
    }
    this.isDirty = true;
    this.isHighlight = false;
  }

  getText() {
    return this.text;
  }

  getPositionIndex(
    tabWidth = typeof SETTINGS_GET === "function"
      ? SETTINGS_GET("editor.tabWidth")
      : 4,
  ) {
    const width = Number.isFinite(Number(tabWidth)) && Number(tabWidth) > 0
      ? Math.floor(Number(tabWidth))
      : 1;
    if (
      !this.positionIndex ||
      this.positionIndex.textVersion !== this.textVersion ||
      this.positionIndex.tabWidth !== width
    ) {
      if (typeof TextPositionIndex !== "function") return null;
      const index = new TextPositionIndex(this.text, width);
      index.textVersion = this.textVersion;
      this.positionIndex = index;
    }
    return this.positionIndex;
  }

  setTokens(tokens) {
    if (this.tokens === tokens) return;
    this.tokens = tokens;
    this.tokensVersion++;
  }

  getTokens() {
    return this.tokens;
  }

  clearTokens() {
    this.tokens = null;
    this.tokensVersion++;
    this.isHighlight = false;
  }

  markDirty() {
    this.isDirty = true;
  }

  markClean() {
    this.isDirty = false;
  }

  setHighlighted(value) {
    this.isHighlight = value;
  }

  setState(state) {
    this.state = state;
  }

  getState() {
    return this.state;
  }

  getLength() {
    return this.text.length;
  }

  isEmpty() {
    return this.text.length === 0;
  }

  clone() {
    const newNode = new LineNode(this.text);
    newNode.tokens = this.tokens;
    newNode.isDirty = this.isDirty;
    newNode.isHighlight = this.isHighlight;
    newNode.state = this.state;
    newNode.diffState = this.diffState;
    newNode.diffSegments = [...(this.diffSegments || [])];
    return newNode;
  }

  toJSON() {
    return {
      text: this.text,
      tokens: this.tokens,
      isHighlight: this.isHighlight,
      state: this.state,
      diffState: this.diffState,
      diffSegments: this.diffSegments,
    };
  }

  static fromJSON(data) {
    const node = new LineNode(data.text || "");
    node.tokens = data.tokens || null;
    node.isHighlight = data.isHighlight || false;
    node.state = data.state || null;
    node.diffState = data.diffState || null;
    node.diffSegments = Array.isArray(data.diffSegments)
      ? data.diffSegments
      : [];
    return node;
  }
}
