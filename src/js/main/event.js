addEvent = (event, f, obj) => {
	if (obj == null || obj == undefined) obj = document;
	if (Array.isArray(obj)) {
		for (let o of obj) {
			o.addEventListener(event, f);
			console.log(o, event, f);
		}
	}else
		obj.addEventListener(event, f);
};

addInterval = (f, time) => {
	return setInterval(f, time);
};

const events = ["cursormove", "cursorchange", "cursordisabled", "cursorenabled", "onSelect"];
const output = document.querySelector(".editor-output");

for (let e of events) {
	addEvent(e, onEvent.bind(e), output);
}

function onEvent(e, name) {
	output.dispatchEvent(
		new CustomEvent("onEvent", {
			detail: { event: name },
		}),
	);
}