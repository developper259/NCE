const baseX = 37;
const baseY = 2;
const posY = 20.5;

addInterval(() => {
  const lines = document.querySelectorAll(".editor-output .output .line");
  for (var i = 0; i < lines.length; i++) {
    const line = lines[i];

    const x = baseX;
    const y = baseY + (posY * i);

    line.style = "position: absolute;" + "top: " + y + "px;" + "left: " + x + "px;";
  }
}, 200);
