//---------SPECIAL LETER FIX---------

const textarea = document.getElementById("editor-area");

    textarea.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault(); 
        const start = this.selectionStart;
        const end = this.selectionEnd;
        const value = this.value;
        const newVal = "  ";
        this.value = value.substring(0, start) + newVal + value.substring(end);
        this.selectionStart = this.selectionEnd = start + newVal.length;
      }
    });

//---------END SPECIAL LETER FIX---------