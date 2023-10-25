const d = document;
const editorOutput = d.querySelector(".editor-output");

addEvent = (event, f, obj) => {
  if (obj == null || obj == undefined) obj = d;
  obj.addEventListener(event, f);
};

addInterval = (f, time) => {
  return setInterval(f, time);
};
