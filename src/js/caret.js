const caret = document.querySelector(".editor-caret");
//marge x et y
const mX = 10;
const mY = 7;

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

    caret.style.left = x + "px";
    caret.style.top = y + "px";

    console.log(x, y);
  },
  editorOutput
);
