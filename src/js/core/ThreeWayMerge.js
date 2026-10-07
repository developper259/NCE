const ThreeWayTextMerge = (() => {
  const DEFAULT_MAX_BYTES = 1024 * 1024;
  const DEFAULT_MAX_LINES = 100000;
  const DEFAULT_MAX_LINE_LENGTH = 1000;
  const DEFAULT_MAX_EDIT_DISTANCE = 256;

  function parseRecords(content) {
    const records = [];
    const newline = /\r\n|\r|\n/g;
    let start = 0;
    let match;
    while ((match = newline.exec(content))) {
      records.push({ text: content.slice(start, match.index), ending: match[0] });
      start = match.index + match[0].length;
    }
    if (start < content.length || records.length === 0)
      records.push({ text: content.slice(start), ending: "" });
    const counts = new Map();
    for (const record of records) {
      if (record.ending) counts.set(record.ending, (counts.get(record.ending) || 0) + 1);
    }
    const eol = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "\n";
    return {
      records,
      eol,
      hasFinalNewline: records.length > 0 && Boolean(records[records.length - 1].ending),
    };
  }

  function utf8Length(value) {
    return new TextEncoder().encode(value).byteLength;
  }

  function findHunks(base, changed, maxEditDistance) {
    let prefix = 0;
    while (prefix < base.length && prefix < changed.length && base[prefix] === changed[prefix])
      prefix++;
    let suffix = 0;
    while (suffix < base.length - prefix && suffix < changed.length - prefix &&
        base[base.length - suffix - 1] === changed[changed.length - suffix - 1])
      suffix++;

    const originalMiddle = base.slice(prefix, base.length - suffix);
    const changedMiddle = changed.slice(prefix, changed.length - suffix);
    const n = originalMiddle.length;
    const m = changedMiddle.length;
    const limit = Math.min(maxEditDistance, n + m);
    const offset = limit + 1;
    let frontier = new Int32Array(limit * 2 + 3);
    frontier.fill(-1);
    frontier[offset + 1] = 0;
    const trace = [];
    let distance = -1;

    search: for (let d = 0; d <= limit; d++) {
      const next = frontier.slice();
      for (let k = -d; k <= d; k += 2) {
        const index = offset + k;
        let x;
        if (k === -d || (k !== d && frontier[index - 1] < frontier[index + 1]))
          x = frontier[index + 1];
        else
          x = frontier[index - 1] + 1;
        let y = x - k;
        while (x >= 0 && y >= 0 && x < n && y < m && originalMiddle[x] === changedMiddle[y]) {
          x++;
          y++;
        }
        next[index] = x;
        if (x >= n && y >= m) {
          trace.push(next);
          distance = d;
          break search;
        }
      }
      trace.push(next);
      frontier = next;
    }
    if (distance < 0) return null;

    const reversed = [];
    let x = n;
    let y = m;
    for (let d = distance; d > 0; d--) {
      const previous = trace[d - 1];
      const k = x - y;
      const index = offset + k;
      const previousK = k === -d ||
        (k !== d && previous[index - 1] < previous[index + 1])
        ? k + 1
        : k - 1;
      const previousX = previous[offset + previousK];
      const previousY = previousX - previousK;
      while (x > previousX && y > previousY) {
        reversed.push({ type: "equal" });
        x--;
        y--;
      }
      if (x === previousX) {
        reversed.push({ type: "insert", sideIndex: prefix + y - 1 });
        y--;
      } else {
        reversed.push({ type: "delete" });
        x--;
      }
    }
    while (x > 0 && y > 0) {
      reversed.push({ type: "equal" });
      x--;
      y--;
    }
    while (x-- > 0) reversed.push({ type: "delete" });
    while (y > 0) {
      reversed.push({ type: "insert", sideIndex: prefix + y - 1 });
      y--;
    }

    const operations = [];
    for (let index = 0; index < prefix; index++) operations.push({ type: "equal" });
    operations.push(...reversed.reverse());
    for (let index = 0; index < suffix; index++) operations.push({ type: "equal" });

    const hunks = [];
    let baseIndex = 0;
    let sideIndex = 0;
    let current = null;
    const finish = () => {
      if (!current) return;
      current.end = baseIndex;
      current.sideEnd = sideIndex;
      hunks.push(current);
      current = null;
    };
    for (const operation of operations) {
      if (operation.type === "equal") {
        finish();
        baseIndex++;
        sideIndex++;
      } else {
        if (!current)
          current = { start: baseIndex, end: baseIndex, sideStart: sideIndex, sideEnd: sideIndex };
        if (operation.type === "delete") baseIndex++;
        else sideIndex++;
      }
    }
    finish();
    return hunks;
  }

  function hunksConflict(left, right) {
    if (left.start === left.end && right.start === right.end)
      return left.start === right.start;
    if (left.start === left.end)
      return left.start > right.start && left.start < right.end;
    if (right.start === right.end)
      return right.start > left.start && right.start < left.end;
    return left.start < right.end && right.start < left.end;
  }

  function mapBaseToSide(baseLength, hunks, sideLength) {
    const mapping = new Int32Array(baseLength);
    mapping.fill(-1);
    let baseIndex = 0;
    let sideIndex = 0;
    for (const hunk of hunks) {
      while (baseIndex < hunk.start) {
        mapping[baseIndex++] = sideIndex++;
      }
      baseIndex = hunk.end;
      sideIndex = hunk.sideEnd;
    }
    while (baseIndex < baseLength) mapping[baseIndex++] = sideIndex++;
    if (sideIndex !== sideLength) return null;
    return mapping;
  }

  function applyRegion(baseRecords, sideRecords, hunks, start, end) {
    const output = [];
    let cursor = start;
    for (const hunk of hunks) {
      if (hunk.start < start || hunk.start > end) continue;
      output.push(...baseRecords.slice(cursor, hunk.start));
      output.push(...sideRecords.slice(hunk.sideStart, hunk.sideEnd));
      cursor = hunk.end;
    }
    output.push(...baseRecords.slice(cursor, end));
    return output;
  }

  function recordsToContent(records, eol, hasFinalNewline) {
    let content = "";
    for (let index = 0; index < records.length; index++) {
      content += records[index].text;
      if (index < records.length - 1)
        content += records[index].ending || eol;
      else if (hasFinalNewline)
        content += records[index].ending || eol;
    }
    return content;
  }

  function merge(baseContent, localContent, diskContent, options = {}) {
    if ([baseContent, localContent, diskContent].some((value) => typeof value !== "string"))
      return { ok: false, reason: "invalid-content" };
    const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    const maxLines = options.maxLines || DEFAULT_MAX_LINES;
    const maxLineLength = options.maxLineLength || DEFAULT_MAX_LINE_LENGTH;
    const maxEditDistance = options.maxEditDistance || DEFAULT_MAX_EDIT_DISTANCE;
    if ([baseContent, localContent, diskContent].some((value) => utf8Length(value) > maxBytes))
      return { ok: false, reason: "file-too-large" };

    const base = parseRecords(baseContent);
    const local = parseRecords(localContent);
    const disk = parseRecords(diskContent);
    if ([base, local, disk].some((value) => value.records.length > maxLines))
      return { ok: false, reason: "too-many-lines" };
    if ([base, local, disk].some((value) =>
      value.records.some((record) => record.text.length > maxLineLength)))
      return { ok: false, reason: "line-too-long" };
    const baseLines = base.records.map((record) => record.text);
    const localLines = local.records.map((record) => record.text);
    const diskLines = disk.records.map((record) => record.text);
    const localHunks = findHunks(baseLines, localLines, maxEditDistance);
    const diskHunks = findHunks(baseLines, diskLines, maxEditDistance);
    if (!localHunks || !diskHunks) return { ok: false, reason: "diff-too-complex" };
    const diskMap = mapBaseToSide(baseLines.length, diskHunks, disk.records.length);
    if (!diskMap) return { ok: false, reason: "invalid-disk-diff" };

    const all = [
      ...localHunks.map((hunk) => ({ ...hunk, source: "local" })),
      ...diskHunks.map((hunk) => ({ ...hunk, source: "disk" })),
    ];
    const sortedHunks = all.map((hunk, index) => ({ hunk, index }))
      .sort((left, right) => left.hunk.start - right.hunk.start ||
        left.hunk.end - right.hunk.end || left.hunk.source.localeCompare(right.hunk.source));
    const consumed = new Set();
    const output = [];
    let baseCursor = 0;
    let conflicts = 0;
    const eol = local.eol !== base.eol ? local.eol : disk.eol;
    let finalNewline = local.hasFinalNewline !== base.hasFinalNewline
      ? local.hasFinalNewline
      : disk.hasFinalNewline;

    while (consumed.size < all.length) {
      const first = sortedHunks.find((entry) => !consumed.has(entry.index));
      if (!first) break;
      const group = [first];
      consumed.add(first.index);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const candidate of sortedHunks) {
          if (consumed.has(candidate.index)) continue;
          if (group.some((member) => member.hunk.source !== candidate.hunk.source &&
              hunksConflict(member.hunk, candidate.hunk))) {
            group.push(candidate);
            consumed.add(candidate.index);
            expanded = true;
          }
        }
      }

      const start = Math.min(...group.map((entry) => entry.hunk.start));
      const end = Math.max(...group.map((entry) => entry.hunk.end));
      if (start < baseCursor) return { ok: false, reason: "overlapping-diff" };
      for (let index = baseCursor; index < start; index++) {
        const diskIndex = diskMap[index];
        output.push(diskIndex >= 0 ? disk.records[diskIndex] : base.records[index]);
      }

      const localGroup = group.filter((entry) => entry.hunk.source === "local")
        .map((entry) => entry.hunk).sort((left, right) => left.start - right.start);
      const diskGroup = group.filter((entry) => entry.hunk.source === "disk")
        .map((entry) => entry.hunk).sort((left, right) => left.start - right.start);
      const localPatch = applyRegion(base.records, local.records, localGroup, start, end);
      const diskPatch = applyRegion(base.records, disk.records, diskGroup, start, end);
      if (localGroup.length && diskGroup.length) {
        if (localPatch.map((record) => record.text).join("\n") ===
            diskPatch.map((record) => record.text).join("\n")) {
          output.push(...diskPatch);
        } else {
          conflicts++;
          output.push({ text: "<<<<<<< LOCAL", ending: eol }, ...localPatch,
            { text: "=======", ending: eol }, ...diskPatch,
            { text: ">>>>>>> DISK", ending: eol });
        }
      } else {
        output.push(...(localGroup.length ? localPatch : diskPatch));
      }
      baseCursor = end;
    }

    for (let index = baseCursor; index < base.records.length; index++) {
      const diskIndex = diskMap[index];
      output.push(diskIndex >= 0 ? disk.records[diskIndex] : base.records[index]);
    }

    const content = recordsToContent(output, eol, finalNewline);
    return {
      ok: true,
      content,
      conflicts,
      changed: content !== localContent,
      baseFingerprint: options.diskFingerprint || null,
      lineCount: output.length,
    };
  }

  return Object.freeze({ merge, parseRecords });
})();
