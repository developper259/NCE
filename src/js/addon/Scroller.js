class Scroller {
  constructor(e) {
    this.editor = e;
    this.id = 0;
    this.scrollX = 0;
    this.scrollY = 0;
    this.type = 0;
    this.active = true;
    this.isBody = true;
    this.isRendering = false;

    this.parentOBJ = null;
    this.scrollerOBJ = null;
    this.itemOBJ = null;

    this.scrollRatio = 0;
    this.strength = 0.2;
    this.renderMargin = 5;

    this.nbItem = 0;
    this.heightByItem = 0;

    this.calculProp = () => 0;
    this.calcIsActive = () => false;
    this.onRefresh = () => {};
    this.onScroll = () => {};
  }

  calcul(diff) {
    return Math.max(100 * Math.pow(0.99, diff), 3);
  }

  init() {
    if (this.scrollerOBJ || this.itemOBJ) return;
  
    this.scrollerOBJ = document.createElement("div");
    this.itemOBJ = document.createElement("div");
  
    this.scrollerOBJ.classList.add("page-scroller", "box");
    this.itemOBJ.classList.add("page-scroller-item");
  
    if (this.isBody) this.scrollerOBJ.classList.add("page-scroller-body");
    if (!this.active) this.scrollerOBJ.classList.add("page-scroller-inactive");
  
    if (this.type === this.editor.scrollerManager.VERTICAL_TYPE) {
      this.scrollerOBJ.classList.add("page-scroller-vertical");
    } else {
      this.scrollerOBJ.classList.add("page-scroller-horizontal");
    }
  
    this.scrollerOBJ.id = this.id;
    this.scrollerOBJ.appendChild(this.itemOBJ);
    this.parentOBJ.appendChild(this.scrollerOBJ);
  
    this.addScrollListeners();
    this.refresh();
  }

  refresh() {
    if (!this.calcIsActive()) {
      this.setActive(false);
      return;
    }
    
    this.setActive(true);
    const proportion = this.calculProp();
    
    if (this.type === this.editor.scrollerManager.VERTICAL_TYPE) {
      const size = (proportion / 100) * this.parentOBJ.clientHeight;
      this.itemOBJ.style.height = `${Math.max(size, 20)}px`;
      this.itemOBJ.style.top = `${this.scrollRatio * (this.parentOBJ.clientHeight - this.itemOBJ.clientHeight)}px`;
    } else {
      const size = (proportion / 100) * this.parentOBJ.clientWidth;
      this.itemOBJ.style.width = `${Math.max(size, 20)}px`;
      this.itemOBJ.style.left = `${this.scrollRatio * (this.parentOBJ.clientWidth - this.itemOBJ.clientWidth)}px`;
    }
  }

  setActive(mode) {
    this.active = mode;
    if (mode) this.scrollerOBJ.classList.remove("page-scroller-inactive");
    else this.scrollerOBJ.classList.add("page-scroller-inactive");
  }

  addScrollListeners() {
    this.isDragging = false;
    this.itemOBJ.addEventListener('mousedown', (e) => { this.isDragging = true; e.preventDefault(); });
    document.addEventListener('mousemove', this.handleMouseMove.bind(this));
    document.addEventListener('mouseup', () => { this.isDragging = false; });
    this.parentOBJ.addEventListener('wheel', this.handleWheel.bind(this), { passive: false });
  }

  handleMouseMove(e) {
    if (!this.isDragging || !this.active) return;

    const rect = this.scrollerOBJ.getBoundingClientRect();
    if (this.type === this.editor.scrollerManager.VERTICAL_TYPE) {
      const maxScroll = this.scrollerOBJ.clientHeight - this.itemOBJ.clientHeight;
      if (maxScroll <= 0) return;
      
      const newTop = Math.max(0, Math.min(e.clientY - rect.top - (this.itemOBJ.clientHeight / 2), maxScroll));
      this.scrollRatio = newTop / maxScroll;
    } else {
      const maxScroll = this.scrollerOBJ.clientWidth - this.itemOBJ.clientWidth;
      if (maxScroll <= 0) return;

      const newLeft = Math.max(0, Math.min(e.clientX - rect.left - (this.itemOBJ.clientWidth / 2), maxScroll));
      this.scrollRatio = newLeft / maxScroll;
    }
    
    this.onScroll(this.scrollRatio);
    this.refresh();
  }

  handleWheel(e) {
    if (!this.active) return;
    e.preventDefault();

    const delta = (this.type === this.editor.scrollerManager.VERTICAL_TYPE) ? e.deltaY : e.deltaX;
    const dimension = (this.type === this.editor.scrollerManager.VERTICAL_TYPE) ? this.scrollerOBJ.clientHeight : this.scrollerOBJ.clientWidth;
    const itemSize = (this.type === this.editor.scrollerManager.VERTICAL_TYPE) ? this.itemOBJ.clientHeight : this.itemOBJ.clientWidth;
    
    const maxScroll = dimension - itemSize;
    if (maxScroll <= 0) return;

    // Mise à jour du ratio basé sur le déplacement
    this.scrollRatio = Math.max(0, Math.min(this.scrollRatio + (delta * this.strength / dimension), 1));
    
    this.onScroll(this.scrollRatio);
    this.refresh();
  }

  getIntervalItem() {
    if (this.nbItem === undefined || this.nbItem === null || this.heightByItem === undefined || this.heightByItem === null || this.heightByItem === 0) {
      return { start: 0, end: 0 };
    }
    
    const visibleItems = Math.ceil(this.parentOBJ.clientHeight / this.heightByItem);
    const maxScrollIndex = Math.max(0, this.nbItem - visibleItems);
    let start = Math.floor(this.scrollRatio * maxScrollIndex) - this.renderMargin;
    let end = Math.min(start + visibleItems, this.nbItem) + this.renderMargin;

    if (start < 0) start = 0;
    if (end > this.nbItem) end = this.nbItem;
    
    return { start, end };
  }
}