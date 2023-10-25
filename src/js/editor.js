const b = document;
const editorOutput = document.querySelector(".editor-output");
let selected = false;

b.addEventListener("click", (e) => {
  const t = e.target;
  if (t.classList.contains("editor-select")) selected = true;
  else selected = false;
});

b.addEventListener("keydown", function (e) {
  const k = e.key;

  if (selected) {
    console.log(k);
  }
});

//cursor-caret
const caret = document.querySelector(".editor-caret");
let caretInterval = setInterval(() => {
  const c = caret.classList;
  if (c.contains("caret-enable") || !selected) c.remove("caret-enable");
  else c.add("caret-enable");
}, 500);

editorOutput.addEventListener("click", (event) => {
const x = event.clientX - editorOutput.getBoundingClientRect().left;
const y = event.clientY - editorOutput.getBoundingClientRect().top;

caret.style.left = x + "px";
caret.style.top = y + "px";

});

const lineNumbers = document.querySelector(".line-numbers");

lineInterval = setInterval(() => {
  const lineCount = editorOutput.querySelectorAll("br").length + 1;
  lineNumbers.innerHTML = Array.from({ length: lineCount }, (_, index) => `<span class="line-el">${index + 1}</span>`).join("");
}, 100);