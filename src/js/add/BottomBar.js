class BottomBar {
	constructor(e) {
		this.editor = e;

		this.line = 0;
		this.column = 0;

		this.cursorOBJ = getElement(".bottomBar-cursor");

		this.refresh = () => {
			this.cursorOBJ.innerText = `Line ${this.line}, Column ${this.column}`;
		}
		
		this.cursorChange = (e) => {
			this.line = e.detail.row;
			this.column = e.detail.column + 1;
			this.refresh();
		};

    	addEvent("cursorchange", this.cursorChange, this.editor.output);
	}
}