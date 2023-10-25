let selected = false;

addEvent("click", (e) => {
  const t = e.target;
  if (t.classList.contains("editor-select")) selected = true;
  else selected = false;
});

// ------ Line number ---------------
const lineNumbers = document.querySelector(".line-numbers");
const output = editorOutput.querySelector(".output");
lineInterval = setInterval(() => {
  const lineCount = editorOutput.querySelectorAll(".line").length;
  lineNumbers.innerHTML = Array.from(
    { length: lineCount },
    (_, index) => `<span class="line-el">${index + 1}</span>`
  ).join("");
}, 200);
