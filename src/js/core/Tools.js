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
  if (window.__domManager && typeof window.__domManager.getElement === "function") {
    return window.__domManager.getElement(str);
  }

  return document.querySelector(str);
};

getElements = (str) => {
  if (window.__domManager && typeof window.__domManager.getElements === "function") {
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

expandTabsForDisplay = (text, tabWidth = CONFIG_GET("tab_width")) => {
  const value = typeof text === "string" ? text : "";
  return value.replace(/\t/g, " ".repeat(normalizeTabWidth(tabWidth)));
};

realColumnToViewColumn = (
  text,
  realColumn,
  tabWidth = CONFIG_GET("tab_width"),
) => {
  const value = typeof text === "string" ? text : "";
  const safeColumn = Math.max(0, Math.min(Number(realColumn) || 0, value.length));
  const before = value.slice(0, safeColumn);
  const tabs = getOccurrence("\t", before);

  return before.length + tabs * (normalizeTabWidth(tabWidth) - 1);
};

viewColumnToRealColumn = (
  text,
  viewColumn,
  tabWidth = CONFIG_GET("tab_width"),
) => {
  const value = typeof text === "string" ? text : "";
  const target = Number(viewColumn) || 0;
  const width = normalizeTabWidth(tabWidth);

  if (target <= 0) return 0;

  let currentViewColumn = 0;
  let realColumn = 0;

  for (const character of value) {
    if (currentViewColumn >= target) break;

    const characterWidth = character === "\t" ? width : 1;
    if (currentViewColumn + characterWidth > target) {
      if (target >= currentViewColumn + characterWidth / 2) {
        realColumn++;
      }
      break;
    }

    currentViewColumn += characterWidth;
    realColumn++;
  }

  return realColumn;
};

getVisualTextLength = (text, tabWidth = CONFIG_GET("tab_width")) => {
  const value = typeof text === "string" ? text : "";
  return realColumnToViewColumn(value, value.length, tabWidth);
};

createElement = (html) => {
  const parser = new DOMParser();
  let doc = parser.parseFromString(html, "text/html");
  return doc.createRange().createContextualFragment(doc.body.innerHTML)
    .firstElementChild;
};
