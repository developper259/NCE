addEvent = (event, f, obj) => {
  if (obj == null || obj == undefined) obj = document;
  obj.addEventListener(event, f);
};

addInterval = (f, time) => {
  return setInterval(f, time);
};
