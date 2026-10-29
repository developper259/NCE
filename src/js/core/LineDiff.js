const LineDiff = {
  MAX_EDIT_DISTANCE: 1200,

  splitLines(content) {
    if (typeof content !== "string" || content === "") return [];
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  },

  buildOperations(beforeLines, afterLines) {
    const prefix = [];
    let prefixLength = 0;
    while (
      prefixLength < beforeLines.length &&
      prefixLength < afterLines.length &&
      beforeLines[prefixLength] === afterLines[prefixLength]
    ) {
      prefix.push({ type: "equal", text: beforeLines[prefixLength] });
      prefixLength += 1;
    }
    let suffixLength = 0;
    while (
      suffixLength < beforeLines.length - prefixLength &&
      suffixLength < afterLines.length - prefixLength &&
      beforeLines[beforeLines.length - suffixLength - 1] ===
        afterLines[afterLines.length - suffixLength - 1]
    )
      suffixLength += 1;

    const before = beforeLines.slice(prefixLength, beforeLines.length - suffixLength);
    const after = afterLines.slice(prefixLength, afterLines.length - suffixLength);
    const maxD = LineDiff.MAX_EDIT_DISTANCE;
    const size = 2 * maxD + 3;
    const offset = maxD + 1;
    const frontier = new Int32Array(size);
    frontier.fill(-1);
    frontier[offset] = 0;
    // trace[d] stores the distance d-1 frontier for k in [-(d-1), d-1].
    const trace = [];
    let solution = null;
    for (let distance = 0; distance <= maxD && solution === null; distance += 1) {
      if (distance > 0) {
        const previous = new Int32Array(distance);
        for (let k = -(distance - 1), index = 0; k <= distance - 1; k += 2, index += 1)
          previous[index] = Math.max(0, frontier[offset + k]);
        trace[distance] = previous;
      }
      for (let k = -distance; k <= distance; k += 2) {
        const index = offset + k;
        const down =
          k === -distance ||
          (k !== distance &&
            (frontier[index - 1] || 0) < (frontier[index + 1] || 0));
        let x = down ? frontier[index + 1] || 0 : (frontier[index - 1] || 0) + 1;
        if (x < 0) x = 0;
        let y = x - k;
        while (
          x < before.length &&
          y < after.length &&
          before[x] === after[y]
        ) {
          x += 1;
          y += 1;
        }
        frontier[index] = x;
        if (x >= before.length && y >= after.length) {
          solution = distance;
          break;
        }
      }
    }

    const middle = [];
    if (solution === null) {
      console.warn("[NCE Diff] large diff fallback", {
        event: "large_diff_fallback",
        beforeLines: beforeLines.length,
        afterLines: afterLines.length,
      });
      for (const text of before) middle.push({ type: "delete", text });
      for (const text of after) middle.push({ type: "insert", text });
    } else {
      let x = before.length;
      let y = after.length;
      const reversed = [];
      for (let distance = solution; distance > 0; distance -= 1) {
        const previous = trace[distance];
        const readPrevious = (k) => {
          const index = (k + distance - 1) / 2;
          return index >= 0 && index < previous.length ? previous[index] : 0;
        };
        const k = x - y;
        const down =
          k === -distance ||
          (k !== distance &&
            readPrevious(k - 1) < readPrevious(k + 1));
        const previousK = down ? k + 1 : k - 1;
        const previousX = readPrevious(previousK);
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
          reversed.push({ type: "equal", text: before[x - 1] });
          x -= 1;
          y -= 1;
        }
        if (down) reversed.push({ type: "insert", text: after[previousY] });
        else reversed.push({ type: "delete", text: before[previousX] });
        x = previousX;
        y = previousY;
      }
      while (x > 0 && y > 0) {
        reversed.push({ type: "equal", text: before[x - 1] });
        x -= 1;
        y -= 1;
      }
      while (x > 0) reversed.push({ type: "delete", text: before[--x] });
      while (y > 0) reversed.push({ type: "insert", text: after[--y] });
      middle.push(...reversed.reverse());
    }
    for (let index = 0; index < suffixLength; index += 1) {
      middle.push({
        type: "equal",
        text: afterLines[afterLines.length - suffixLength + index],
      });
    }
    return prefix.concat(middle);
  },

  buildRows(beforeText, afterText) {
    const operations = LineDiff.buildOperations(
      LineDiff.splitLines(beforeText),
      LineDiff.splitLines(afterText),
    );
    const rows = [];
    let documentIndex = 0;
    let oldLineNumber = 0;
    let newLineNumber = 0;
    for (const operation of operations) {
      if (operation.type === "equal") {
        oldLineNumber += 1;
        newLineNumber += 1;
        rows.push({
          type: "unchanged",
          text: operation.text,
          documentIndex,
          oldLineNumber,
          newLineNumber,
        });
        documentIndex += 1;
      } else if (operation.type === "delete") {
        oldLineNumber += 1;
        rows.push({
          type: "removed",
          text: operation.text,
          documentIndex: null,
          oldLineNumber,
          newLineNumber: null,
        });
      } else {
        newLineNumber += 1;
        rows.push({
          type: "added",
          text: operation.text,
          documentIndex,
          oldLineNumber: null,
          newLineNumber,
        });
        documentIndex += 1;
      }
    }
    return rows;
  },

  buildDocumentLines(rows) {
    const lines = [];
    for (const row of rows) {
      if (row.type !== "removed") lines.push(row.text);
    }
    return lines;
  },
};
