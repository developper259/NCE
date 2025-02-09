class Scroller {
  constructor(e) {
    this.editor = e;

    this.id = 0;

    this.scrollX = 1;
    this.scrollY = 1;

    this.maxScroll = 2;
    this.maxScroll = 2;

    this.type = 0;
    this.active = false;
    this.isBody = true;

    this.parentOBJ;
    this.targetOBJ;
    this.scrollerOBJ;
    this.itemOBJ;

    this.calculProp = () => 0;
    this.calcIsActive = () => false;
  }

  calcul(diff) {
    // reduit de a% diff fois(length / maxLines) obtient un pourcentage | a chaque fois a% augmente
    // limite 3% : 0.99 pour eviter d'augmenter la taille du scroller
    return Math.max(
      Array.from({ length: diff }).reduce(
        (r, _, i) => r * Math.min(0.98 + i * 0.0001, 0.99),
        100
      ),
      3
    );
  }

  init() {
    if (this.scrollerOBJ || this.itemOBJ) return;

    let classes = this.isBody
      ? "page-scroller-body"
      : "" + !this.active
      ? " page-scroller-inactive"
      : "";
    classes +=
      this.type == this.editor.scrollerManager.VERTICAL_TYPE
        ? " page-scroller-vertical"
        : " page-scroller-horizontal";

    const html = `<div class="page-scroller ${classes}" id="${this.id}">
                        <div class="page-scroller-item"></div>
                      </div>`;

    this.parentOBJ.appendChild(createElement(html));

    this.scrollerOBJ = this.parentOBJ.querySelector(".page-scroller");
    if (this.scrollerOBJ)
      this.itemOBJ = this.scrollerOBJ.querySelector(".page-scroller-item");

    this.refresh();
  }

  refresh() {
    if (!this.calcIsActive()) return;
    if (this.type === this.editor.scrollerManager.VERTICAL_TYPE) {
      this.scrollerOBJ.style.height = this.targetOBJ.style.height;

      const proportion = this.calculProp();
      const size = (proportion / 100) * this.targetOBJ.clientHeight;

      if (proportion == 0) {
        this.setActive(false);
        return;
      } else {
        this.setActive(true);
      }

      this.itemOBJ.style.height = `${size}px`;
    } else {
      const authorScroller = this.editor.scrollerManager.getScrollerByParent(
        this.parentOBJ
      );
      this.scrollerOBJ.style.width = this.targetOBJ.style.width;
      this.scrollerOBJ.style.left = this.targetOBJ.style.left;

      const proportion = this.calculProp();
      const size = (proportion / 100) * this.targetOBJ.clientWidth;

      if (proportion == 0) {
        this.setActive(false);
        return;
      } else {
        this.setActive(true);
      }

      this.itemOBJ.style.width = `${size}px`;
    }
  }

  onScroll() {}

  scroll(x, y) {}

  setScroll(x, y) {
    this.scrollX = x;
    this.scrollY = y;

    this.editor.refreshAll();
  }

  setActive(mode) {
    if (mode) this.scrollerOBJ.classList.remove("page-scroller-inactive");
    else this.scrollerOBJ.classList.add("page-scroller-inactive");
  }
}
