class LineNode {
  constructor(text = "") {
    this.text = text;
    this.tokens = null;
    this.isDirty = false;
    this.isHighlight = false;
    this.state = null;
    this.diffState = null;
    this.diffSegments = [];
  }

  setText(text) {
    this.text = text;
    this.isDirty = true;
    this.isHighlight = false;
  }

  getText() {
    return this.text;
  }

  setTokens(tokens) {
    this.tokens = tokens;
  }

  getTokens() {
    return this.tokens;
  }

  clearTokens() {
    this.tokens = null;
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
    node.diffSegments = Array.isArray(data.diffSegments) ? data.diffSegments : [];
    return node;
  }
}
