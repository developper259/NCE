const LineDiff = {
  MAX_EDIT_DISTANCE: 2000,

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
    let frontier = new Map([[0, 0]]);
    const trace = [];
    let solution = null;
    for (let distance = 0; distance <= maxD && solution === null; distance += 1) {
      trace.push(new Map(frontier));
      for (let k = -distance; k <= distance; k += 2) {
        const down =
          k === -distance ||
          (k !== distance &&
            (frontier.get(k - 1) || 0) < (frontier.get(k + 1) || 0));
        let x = down
          ? frontier.get(k + 1) || 0
          : (frontier.get(k - 1) || 0) + 1;
        let y = x - k;
        while (
          x < before.length &&
          y < after.length &&
          before[x] === after[y]
        ) {
          x += 1;
          y += 1;
        }
        frontier.set(k, x);
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
        const k = x - y;
        const down =
          k === -distance ||
          (k !== distance &&
            (previous.get(k - 1) || 0) < (previous.get(k + 1) || 0));
        const previousK = down ? k + 1 : k - 1;
        const previousX = previous.get(previousK) || 0;
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
