const caret = document.querySelector(".editor-caret");
//marge x et y
const mX = 10;
const mY = 7;

const mpY = 21;
const mpX = 10;

round = (nb) => {
  console.log(nb);
  var r = nb;
  while(nb > 1) {
    nb--;
  }
  r -= nb;
  if (nb >= 0.65) nb = 1;
  else nb = 0;

  return r + nb;
}



addInterval(() => {
  const c = caret.classList;
  if (c.contains("caret-enable") || !selected) c.remove("caret-enable");
  else c.add("caret-enable");
}, 500);

addEvent(
  "click",
  (event) => {
    const x = event.clientX - editorOutput.getBoundingClientRect().left - mX;
    const y = event.clientY - editorOutput.getBoundingClientRect().top - mY;

    calcY = round(((y - baseY) / posY) + 1);

    const linesN = document.querySelectorAll(".line-numbers .line-el");

    if (calcY > linesN.length) calcY = linesN.length;

    placeY = (baseY + posY * calcY) - mpY;

    caret.style.left = x + "px";
    caret.style.top = placeY + "px";

    const currentLine = linesN[calcY - 1];
    const oldLine = document.querySelector(".line-selected");

    if (oldLine != null && oldLine != undefined) oldLine.classList.remove("line-selected");

    if (!caret.classList.contains("caret-enable")) caret.classList.add("caret-enable");
    currentLine.classList.add("line-selected");
  },
  editorOutput
);