// Runtime-only horizontal metrics for one immutable snapshot of a line.
// ASCII lines use their UTF-16 offsets directly and keep only tab offsets;
// Unicode lines keep sparse grapheme checkpoints and scan at most one block
// for each position lookup.
class TextPositionIndex {
  constructor(text = "", tabWidth = 4) {
    this.text = typeof text === "string" ? text : "";
    this.tabWidth = Number.isFinite(Number(tabWidth)) && Number(tabWidth) > 0
      ? Math.floor(Number(tabWidth))
      : 1;
    this.kind = null;
    this.tabOffsets = [];
    this.checkpoints = [];
    this.wordSeparators = new Map();
    this.visualLength = this.text.length;
    this.metrics = { charactersScanned: 0, boundariesMaterialized: 0 };
    this.segmenter = TextPositionIndex.getSharedSegmenter();
    this.initialize();
  }

  static getSharedSegmenter() {
    if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function")
      return null;
    return this._sharedSegmenter ||= new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
  }

  static getVisualLength(text, tabWidth = 4) {
    const value = typeof text === "string" ? text : "";
    const width = Number.isFinite(Number(tabWidth)) && Number(tabWidth) > 0
      ? Math.floor(Number(tabWidth))
      : 1;
    if (value.search(/[^\x00-\x7f]/) < 0) {
      let tabs = 0;
      for (let at = value.indexOf("\t"); at !== -1; at = value.indexOf("\t", at + 1)) tabs++;
      return value.length + tabs * (width - 1);
    }
    let visual = 0;
    const segmenter = this.getSharedSegmenter();
    if (segmenter) {
      for (const item of segmenter.segment(value))
        visual += item.segment === "\t" ? width : 1;
      return visual;
    }
    for (let real = 0; real < value.length;) {
      const codePoint = value.codePointAt(real);
      const end = real + (codePoint > 0xffff ? 2 : 1);
      visual += value.slice(real, end) === "\t" ? width : 1;
      real = end;
    }
    return visual;
  }

  initialize() {
    // Native string search avoids a JS allocation per character. The explicit
    // ASCII scan below only runs once when sparse tab offsets are needed.
    const firstNonAscii = this.text.search(/[^\x00-\x7f]/);
    this.metrics.charactersScanned += firstNonAscii < 0
      ? this.text.length
      : firstNonAscii + 1;
    if (firstNonAscii < 0) {
      this.kind = "ascii";
      let searchFrom = 0;
      let at = this.text.indexOf("\t", searchFrom);
      while (at !== -1) {
        this.metrics.charactersScanned += at - searchFrom + 1;
        this.tabOffsets.push(at);
        searchFrom = at + 1;
        at = this.text.indexOf("\t", searchFrom);
      }
      this.metrics.charactersScanned += this.text.length - searchFrom;
      this.visualLength = this.text.length + this.tabOffsets.length * (this.tabWidth - 1);
      return;
    }

    this.kind = "unicode";
    this.buildUnicodeCheckpoints();
  }

  applyAsciiEdit(newText, start, oldEnd, insertedText) {
    if (this.kind !== "ascii" || /[^\x00-\x7f]/.test(insertedText)) return false;
    const safeStart = Math.max(0, Math.min(start, this.text.length));
    const safeEnd = Math.max(safeStart, Math.min(oldEnd, this.text.length));
    let low = 0;
    let high = this.tabOffsets.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.tabOffsets[mid] < safeStart) low = mid + 1;
      else high = mid;
    }
    const firstRemoved = low;
    let lastRemoved = firstRemoved;
    while (lastRemoved < this.tabOffsets.length && this.tabOffsets[lastRemoved] < safeEnd) lastRemoved++;
    const removedTabs = lastRemoved - firstRemoved;
    const delta = insertedText.length - (safeEnd - safeStart);
    const after = this.tabOffsets.slice(lastRemoved).map((real) => real + delta);
    const before = this.tabOffsets.slice(0, firstRemoved);
    const insertedTabs = [];
    for (let at = insertedText.indexOf("\t"); at !== -1; at = insertedText.indexOf("\t", at + 1))
      insertedTabs.push(safeStart + at);
    this.tabOffsets = before.concat(insertedTabs, after);
    this.visualLength += delta + (insertedTabs.length - removedTabs) * (this.tabWidth - 1);
    this.text = newText;
    this.wordSeparators.clear();
    return true;
  }

  getWordSeparatorSet(separators) {
    const separatorChars = Array.from(new Set(separators || []));
    const key = separatorChars.join("");
    const cached = this.wordSeparators.get(key);
    if (cached) return cached;
    const value = new Set(separatorChars);
    this.wordSeparators.set(key, value);
    return value;
  }

  isWordSeparatorAt(real, separators) {
    if (real < 0 || real >= this.text.length) return false;
    this.metrics.charactersScanned++;
    const codePoint = this.text.codePointAt(real);
    return separators.has(String.fromCodePoint(codePoint));
  }

  getWordRangeAt(real, separators) {
    const separatorSet = this.getWordSeparatorSet(separators);
    if (!this.text.length) return { start: 0, end: 0, separator: false };
    let position = Math.max(0, Math.min(Number(real) || 0, this.text.length));
    if (position === this.text.length) position = this.previous(position);
    else position = this.normalize(position, "previous");
    const firstEnd = this.next(position);
    if (this.isWordSeparatorAt(position, separatorSet))
      return { start: position, end: firstEnd, separator: true };

    let start = position;
    while (start > 0) {
      const previous = this.previous(start);
      if (this.isWordSeparatorAt(previous, separatorSet)) break;
      start = previous;
    }
    let end = firstEnd;
    while (end < this.text.length && !this.isWordSeparatorAt(end, separatorSet))
      end = this.next(end);
    return { start, end, separator: false };
  }

  previousWordBoundary(real, separators) {
    const separatorSet = this.getWordSeparatorSet(separators);
    let position = Math.max(0, Math.min(Number(real) || 0, this.text.length));
    while (position > 0) {
      let previous = this.previous(position);
      if (this.isWordSeparatorAt(previous, separatorSet)) {
        position = previous;
        continue;
      }
      while (previous > 0) {
        const beforePrevious = this.previous(previous);
        if (this.isWordSeparatorAt(beforePrevious, separatorSet)) break;
        previous = beforePrevious;
      }
      return previous;
    }
    return 0;
  }

  nextWordBoundary(real, separators) {
    const separatorSet = this.getWordSeparatorSet(separators);
    const position = Math.max(0, Math.min(Number(real) || 0, this.text.length));
    if (position >= this.text.length) return this.text.length;
    const start = this.normalize(position, "previous");
    let end = this.next(start);
    if (this.isWordSeparatorAt(start, separatorSet)) return end;
    while (end < this.text.length && !this.isWordSeparatorAt(end, separatorSet))
      end = this.next(end);
    return end;
  }

  buildUnicodeCheckpoints() {
    this.checkpoints = [{ real: 0, visual: 0 }];
    if (!this.text) {
      this.visualLength = 0;
      return;
    }

    let count = 0;
    let visual = 0;
    if (this.segmenter) {
      for (const item of this.segmenter.segment(this.text)) {
        this.metrics.charactersScanned += item.segment.length;
        if (count > 0 && count % TextPositionIndex.CHECKPOINT_GRAPHEMES === 0) {
          this.checkpoints.push({ real: item.index, visual });
        }
        visual += item.segment === "\t" ? this.tabWidth : 1;
        count++;
      }
    } else {
      for (let real = 0; real < this.text.length; ) {
        this.metrics.charactersScanned++;
        if (count > 0 && count % TextPositionIndex.CHECKPOINT_GRAPHEMES === 0)
          this.checkpoints.push({ real, visual });
        const codePoint = this.text.codePointAt(real);
        const end = real + (codePoint > 0xffff ? 2 : 1);
        const segment = this.text.slice(real, end);
        visual += segment === "\t" ? this.tabWidth : 1;
        real = end;
        count++;
      }
    }
    this.visualLength = visual;
  }

  getSegmentsFrom(real) {
    const found = this.lowerBound(this.checkpoints, real, "real");
    const checkpointIndex = this.checkpoints[found]?.real === real
      ? found
      : Math.max(0, found - 1);
    const checkpoint = this.checkpoints[checkpointIndex];
    const nextCheckpoint = this.checkpoints[checkpointIndex + 1];
    const end = nextCheckpoint?.real ?? this.text.length;
    if (!this.segmenter) {
      const text = this.text;
      return (function* () {
        for (let offset = checkpoint.real; offset < end;) {
          const codePoint = text.codePointAt(offset);
          const next = offset + (codePoint > 0xffff ? 2 : 1);
          yield { index: offset - checkpoint.real, segment: text.slice(offset, next) };
          offset = next;
        }
      })();
    }
    // Segment only one sparse block. Segmenting the suffix here would keep a
    // second million-character string alive for every local cursor lookup.
    return this.segmenter.segment(this.text.slice(checkpoint.real, end));
  }

  lowerBound(items, value, key) {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (items[mid][key] < value) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  checkpointByReal(real) {
    const index = this.lowerBound(this.checkpoints, real, "real");
    if (this.checkpoints[index]?.real === real) return this.checkpoints[index];
    return this.checkpoints[Math.max(0, index - 1)];
  }

  checkpointByVisual(visual) {
    const index = this.lowerBound(this.checkpoints, visual, "visual");
    if (this.checkpoints[index]?.visual === visual) return this.checkpoints[index];
    return this.checkpoints[Math.max(0, index - 1)];
  }

  tabCountBefore(real) {
    let low = 0;
    let high = this.tabOffsets.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.tabOffsets[mid] < real) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  normalize(real, bias = "nearest") {
    const offset = Math.max(0, Math.min(Number(real) || 0, this.text.length));
    if (this.kind === "ascii" || offset === 0 || offset === this.text.length) return offset;
    const checkpoint = this.checkpointByReal(offset);
    let previous = checkpoint.real;
    for (const item of this.getSegmentsFrom(checkpoint.real) || []) {
      this.metrics.charactersScanned += item.segment.length;
      const start = checkpoint.real + item.index;
      const end = start + item.segment.length;
      if (offset === start) return start;
      if (offset < end) {
        if (bias === "previous") return start;
        if (bias === "next") return end;
        return offset - start <= end - offset ? start : end;
      }
      if (offset === end) return end;
      previous = end;
      if (start >= offset) break;
    }
    return previous;
  }

  previous(real) {
    const offset = Math.max(0, Math.min(Number(real) || 0, this.text.length));
    if (this.kind === "ascii") return Math.max(0, offset - 1);
    if (offset === 0) return 0;
    let checkpoint = this.checkpointByReal(offset);
    if (checkpoint.real === offset && checkpoint.real > 0) {
      const checkpointIndex = this.lowerBound(this.checkpoints, offset, "real");
      checkpoint = this.checkpoints[Math.max(0, checkpointIndex - 1)];
    }
    let previous = checkpoint.real;
    for (const item of this.getSegmentsFrom(checkpoint.real) || []) {
      this.metrics.charactersScanned += item.segment.length;
      const start = checkpoint.real + item.index;
      const end = start + item.segment.length;
      if (start >= offset) return previous;
      if (end >= offset) return start;
      previous = end;
    }
    return previous;
  }

  next(real) {
    const offset = Math.max(0, Math.min(Number(real) || 0, this.text.length));
    if (this.kind === "ascii") return Math.min(this.text.length, offset + 1);
    if (offset >= this.text.length) return this.text.length;
    const checkpoint = this.checkpointByReal(offset);
    for (const item of this.getSegmentsFrom(checkpoint.real) || []) {
      this.metrics.charactersScanned += item.segment.length;
      const start = checkpoint.real + item.index;
      const end = start + item.segment.length;
      if (start >= offset) return start > offset ? start : end;
      if (end > offset) return end;
    }
    return this.text.length;
  }

  realToVisual(real) {
    const offset = this.normalize(real, "previous");
    if (this.kind === "ascii")
      return offset + this.tabCountBefore(offset) * (this.tabWidth - 1);
    const checkpoint = this.checkpointByReal(offset);
    let visual = checkpoint.visual;
    for (const item of this.getSegmentsFrom(checkpoint.real) || []) {
      this.metrics.charactersScanned += item.segment.length;
      const start = checkpoint.real + item.index;
      if (start >= offset) break;
      visual += item.segment === "\t" ? this.tabWidth : 1;
    }
    return visual;
  }

  visualToReal(visual, bias = "nearest") {
    const target = Math.max(0, Number(visual) || 0);
    if (this.kind === "ascii") {
      let low = 0;
      let high = this.tabOffsets.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        const tab = this.tabOffsets[mid];
        const tabVisual = tab + mid * (this.tabWidth - 1);
        if (tabVisual < target) low = mid + 1;
        else high = mid;
      }
      const candidate = Math.max(0, low - 1);
      if (this.tabOffsets.length) {
        const tab = this.tabOffsets[candidate];
        const tabVisual = tab + candidate * (this.tabWidth - 1);
        if (target >= tabVisual && target < tabVisual + this.tabWidth) {
          if (bias === "previous") return tab;
          if (bias === "next") return tab + 1;
          return target >= tabVisual + this.tabWidth / 2 ? tab + 1 : tab;
        }
      }
      const tabsBefore = low;
      return Math.max(0, Math.min(Math.floor(target - tabsBefore * (this.tabWidth - 1)), this.text.length));
    }

    if (target <= 0) return 0;
    const checkpoint = this.checkpointByVisual(target);
    let real = checkpoint.real;
    let currentVisual = checkpoint.visual;
    for (const item of this.getSegmentsFrom(checkpoint.real) || []) {
      this.metrics.charactersScanned += item.segment.length;
      const start = checkpoint.real + item.index;
      const end = start + item.segment.length;
      const width = item.segment === "\t" ? this.tabWidth : 1;
      if (currentVisual + width > target) {
        if (item.segment === "\t" && bias === "previous") return start;
        if (item.segment === "\t" && bias === "next") return end;
        return target >= currentVisual + width / 2 ? end : start;
      }
      currentVisual += width;
      real = end;
      if (currentVisual >= target) break;
    }
    return real;
  }

  sliceVisualRange(startVisual, maxVisualColumns) {
    const start = Math.max(0, Number(startVisual) || 0);
    const end = Math.min(this.visualLength, start + Math.max(0, Number(maxVisualColumns) || 0));
    const startReal = this.visualToReal(start, "previous");
    const endReal = this.visualToReal(end, "next");
    const segments = [];
    let displayText = "";
    let visual = this.realToVisual(startReal);

    if (this.kind === "ascii") {
      let real = startReal;
      while (real < endReal && visual < end) {
        this.metrics.charactersScanned++;
        const char = this.text[real];
        const width = char === "\t" ? this.tabWidth : 1;
        const clippedStart = Math.max(visual, start);
        const clippedEnd = Math.min(visual + width, end);
        const displayStart = displayText.length;
        if (clippedEnd > clippedStart) {
          displayText += char === "\t" ? " ".repeat(clippedEnd - clippedStart) : char;
          segments.push({ realStart: real, realEnd: real + 1, displayStart, displayEnd: displayText.length });
        }
        visual += width;
        real++;
      }
    } else {
      const checkpoint = this.checkpointByReal(startReal);
      for (const item of this.getSegmentsFrom(checkpoint.real) || []) {
        this.metrics.charactersScanned += item.segment.length;
        const realStart = checkpoint.real + item.index;
        const realEnd = realStart + item.segment.length;
        if (realEnd <= startReal) continue;
        if (realStart >= endReal || visual >= end) break;
        const width = item.segment === "\t" ? this.tabWidth : 1;
        const clippedStart = Math.max(visual, start);
        const clippedEnd = Math.min(visual + width, end);
        const displayStart = displayText.length;
        if (clippedEnd > clippedStart) {
          displayText += item.segment === "\t"
            ? " ".repeat(clippedEnd - clippedStart)
            : item.segment;
          segments.push({ realStart, realEnd, displayStart, displayEnd: displayText.length });
        }
        visual += width;
      }
    }

    const sourceStart = segments.length ? segments[0].realStart : startReal;
    const sourceEnd = segments.length ? segments[segments.length - 1].realEnd : sourceStart;
    return {
      text: this.text.slice(sourceStart, sourceEnd),
      displayText,
      startChar: sourceStart,
      endChar: sourceEnd,
      startReal: sourceStart,
      endReal: sourceEnd,
      startVisual: start,
      endVisual: end,
      segments,
    };
  }
}

TextPositionIndex.CHECKPOINT_GRAPHEMES = 128;
