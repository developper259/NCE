let selected = false;

addEvent("click", (e) => {
  const t = e.target;
  const c = t.classList;
  if (c.contains("editor-select") || c.contains("editor-el")) selected = true;
  else selected = false;
});