const baseX = 39;
const baseY = 2;
const posY = 21;

addInterval(() => {
  //line
  const lines = document.querySelectorAll(".editor-output .output .line");
  for (var i = 0; i < lines.length; i++) {
    const line = lines[i];

    const x = baseX;
    const y = baseY + posY * i;

    line.style.position = "absolute";
    line.style.top = y + "px";
    line.style.left = x + "px";
  }

  //line number
  const lineN = document.querySelector(".line-numbers");
  var lineCount = editorOutput.querySelectorAll(".line").length;
  var linesN = lineN.querySelectorAll(".line-el");

  if (lineCount == 0) lineCount = 1;
  if (lineCount != linesN.length) {
    lineN.innerHTML = Array.from(
      { length: lineCount },
      (_, index) => `<span class="line-el">${index + 1}</span>`
    ).join("");

    linesN = lineN.querySelectorAll(".line-el");

    for (var i = 0; i < linesN.length; i++) {
      const line = linesN[i];

      const y = baseY + posY * i;

      line.style.top = y + "px";
    }
  }
}, 100);
