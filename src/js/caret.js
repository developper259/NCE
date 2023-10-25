const caret = document.querySelector(".editor-caret");

addInterval(() => {
  const c = caret.classList;
  if (c.contains("caret-enable") || !selected) c.remove("caret-enable");
  else c.add("caret-enable");
}, 500);

addEvent(
  "click",
  (event) => {
    const x = event.clientX - editorOutput.getBoundingClientRect().left;
    const y = event.clientY - editorOutput.getBoundingClientRect().top;

    caret.style.left = x + "px";
    caret.style.top = y + "px";
  },
  editorOutput
);
