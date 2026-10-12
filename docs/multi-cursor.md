# Multi-cursor editing

NCE stores cursor selections on each editable `FileNode`. One selection is the
primary cursor used by the existing editor APIs; the remaining selections are
normalized, sorted and rendered as virtualized overlays. Moving to another file
restores that file's own selections. Workspace state persists the secondary
selections with a 512-selection restore limit; live editing supports up to 1024.

## Editing behavior

- Alt/Option-click adds a caret. Repeating the modified click removes a matching
  secondary caret. A normal click returns to one cursor.
- Add Cursor Above/Below, Add Cursor at Next Occurrence, Select All Occurrences
  and Remove Secondary Cursors are available in the command palette and Edit
  menu. Defaults are Alt+Shift+Up/Down, Mod+D and Mod+Shift+L; all are editable
  in Settings → Keybindings. Escape removes secondary cursors after higher
  priority panels have had a chance to close.
- Typing, Backspace, Delete, Enter, Tab/Shift+Tab, multiline paste and selected
  text copy/cut use one batch transaction. Clipboard selections are joined in
  document order with LF separators. Copy/cut with only carets uses each unique
  caret line once.
- Overlapping selections merge while adjacent selections remain independent.
  Duplicate carets are removed. A batch that fails validation is rejected
  before changing the document.
- Batches are limited to 1024 edits and 32 MiB of combined inserted text.
  Occurrence commands inspect at most 16 MiB and create at most 1024 selections.
  Large-file, diff and incompletely loaded files remain on the existing safe
  paths and do not accept multi-cursor edits.

Batch edits are planned from the pre-edit document, applied from the last
affected line toward the first, and produce one history record and one change
notification. Consecutive ordinary multi-cursor typing can coalesce when every
caret continues at the end of its inserted text; smart-pair insertion is kept
as a separate undo step because its caret sits inside the pair. Newline styles
for untouched source lines are retained; inserted newlines use the file's
detected EOL style.

## Benchmark

Run `npm run benchmark:multi-cursor`. It reports median and p95 insertion
latency, plus observed heap deltas, for 2–1000 cursors across 100–100,000-line
documents. The benchmark prints the Node version, operating system, CPU count,
sample count and whether explicit garbage collection was available. Set
`NCE_BENCH_SAMPLES` and `NCE_BENCH_WARMUPS` to change iteration counts. Heap
deltas are observational and should be compared only under the same runtime and
machine conditions.
