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
    return document.querySelector(str);
  };
  
  getElements = (str) => {
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
  
  createElement = (html) => {
    const parser = new DOMParser();
    let doc = parser.parseFromString(html, "text/html");
    return doc.createRange().createContextualFragment(doc.body.innerHTML)
      .firstElementChild;
  };