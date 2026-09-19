roundY = (nb) => {
  var r = nb;
  while (nb > 1) {
    nb--;
  }
  r -= nb;
  if (nb >= 0.65) nb = 1;
  else nb = 0;

  return r + nb;
};

roundX = (nb) => {
  if (nb < 0) return -1;
  if (nb < 1) return 0;
  var r = nb;
  while (nb > 1) {
    nb--;
  }
  r -= nb;
  if (nb >= 0.65) nb = 1;
  else nb = 0;

  return r + nb;
};

getElement = (str) => {
  if (
    window.__domManager &&
    typeof window.__domManager.getElement === "function"
  ) {
    return window.__domManager.getElement(str);
  }

  return document.querySelector(str);
};

getElements = (str) => {
  if (
    window.__domManager &&
    typeof window.__domManager.getElements === "function"
  ) {
    return window.__domManager.getElements(str);
  }

  return nodeToArray(document.querySelectorAll(str));
};

nodeToArray = (node) => {
  let r = [];

  for (let n of node) {
    r.push(n);
  }

  return r;
};

getOccurrence = (c, str) => {
  return str.split(c).length - 1;
};

normalizeTabWidth = (tabWidth) => {
  const width = Number(tabWidth);
  return Number.isFinite(width) && width > 0 ? Math.floor(width) : 1;
};

let nceGraphemeSegmenter;

getGraphemeBoundaries = (text) => {
  const value = typeof text === "string" ? text : "";
  if (!value) return [0];
  if (/^[\x00-\x7f]*$/.test(value)) {
    return Array.from({ length: value.length + 1 }, (_, index) => index);
  }

  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    nceGraphemeSegmenter ||= new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    const boundaries = [0];
    for (const segment of nceGraphemeSegmenter.segment(value)) {
      const end = segment.index + segment.segment.length;
      if (end > boundaries[boundaries.length - 1]) boundaries.push(end);
    }
    if (boundaries[boundaries.length - 1] !== value.length)
      boundaries.push(value.length);
    return boundaries;
  }

  const boundaries = [0];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    index += codePoint > 0xffff ? 2 : 1;
    while (
      index < value.length &&
      /[\u0300-\u036f\uFE00-\uFE0F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/u.test(
        value[index],
      )
    )
      index++;
    if (value[index] === "\u200d" && index + 1 < value.length) {
      index++;
      continue;
    }
    boundaries.push(index);
  }
  return boundaries;
};

normalizeTextBoundary = (text, utf16Offset, bias = "nearest") => {
  const value = typeof text === "string" ? text : "";
  const offset = Math.max(0, Math.min(Number(utf16Offset) || 0, value.length));
  const boundaries = getGraphemeBoundaries(value);
  if (boundaries.includes(offset)) return offset;
  let right = boundaries.find((boundary) => boundary > offset);
  let left =
    boundaries[boundaries.findIndex((boundary) => boundary > offset) - 1];
  if (bias === "previous") return left ?? 0;
  if (bias === "next") return right ?? value.length;
  return offset - left <= right - offset ? left : right;
};

previousGraphemeBoundary = (text, utf16Offset) => {
  const value = typeof text === "string" ? text : "";
  const boundaries = getGraphemeBoundaries(value);
  const offset = Math.max(0, Math.min(Number(utf16Offset) || 0, value.length));
  let index = 0;
  while (index < boundaries.length && boundaries[index] < offset) index++;
  return boundaries[Math.max(0, index - 1)];
};

nextGraphemeBoundary = (text, utf16Offset) => {
  const value = typeof text === "string" ? text : "";
  const boundaries = getGraphemeBoundaries(value);
  const offset = Math.max(0, Math.min(Number(utf16Offset) || 0, value.length));
  let index = 0;
  while (index < boundaries.length && boundaries[index] <= offset) index++;
  return boundaries[Math.min(boundaries.length - 1, index)];
};

expandTabsForDisplay = (text, tabWidth = SETTINGS_GET("editor.tabWidth")) => {
  const value = typeof text === "string" ? text : "";
  return value.replace(/\t/g, " ".repeat(normalizeTabWidth(tabWidth)));
};

realColumnToViewColumn = (
  text,
  realColumn,
  tabWidth = SETTINGS_GET("editor.tabWidth"),
) => {
  const value = typeof text === "string" ? text : "";
  const safeColumn = normalizeTextBoundary(value, realColumn, "previous");
  const width = normalizeTabWidth(tabWidth);
  let viewColumn = 0;
  for (const boundary of getGraphemeBoundaries(value)) {
    if (boundary >= safeColumn) break;
    const grapheme = value.slice(
      boundary,
      nextGraphemeBoundary(value, boundary),
    );
    viewColumn += grapheme === "\t" ? width : 1;
  }
  return viewColumn;
};

viewColumnToRealColumn = (
  text,
  viewColumn,
  tabWidth = SETTINGS_GET("editor.tabWidth"),
) => {
  const value = typeof text === "string" ? text : "";
  const target = Number(viewColumn) || 0;
  const width = normalizeTabWidth(tabWidth);

  if (target <= 0) return 0;

  let currentViewColumn = 0;
  let realColumn = 0;
  const boundaries = getGraphemeBoundaries(value);

  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    const grapheme = value.slice(start, end);
    if (currentViewColumn >= target) break;

    const characterWidth = grapheme === "\t" ? width : 1;
    if (currentViewColumn + characterWidth > target) {
      if (target >= currentViewColumn + characterWidth / 2) {
        realColumn = end;
      }
      break;
    }

    currentViewColumn += characterWidth;
    realColumn = end;
  }

  return realColumn;
};

getVisualTextLength = (text, tabWidth = SETTINGS_GET("editor.tabWidth")) => {
  const value = typeof text === "string" ? text : "";
  return realColumnToViewColumn(value, value.length, tabWidth);
};

NCETextPosition = {
  getGraphemeBoundaries,
  normalizeTextBoundary,
  previousGraphemeBoundary,
  nextGraphemeBoundary,
  realColumnToViewColumn,
  viewColumnToRealColumn,
};

createElement = (html) => {
  const parser = new DOMParser();
  let doc = parser.parseFromString(html, "text/html");
  return doc.createRange().createContextualFragment(doc.body.innerHTML)
    .firstElementChild;
};
