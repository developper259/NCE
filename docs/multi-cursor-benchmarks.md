# Multi-cursor benchmark results

Measurements collected 2026-10-12 on macOS x64, Intel Core i5-5350U at
1.80 GHz, 4 reported CPU cores, Electron 42.11.2 / Chromium 148.0.7778.280.
The historical Electron comparison used the pre-multi-cursor base
`8cdf86aa9ff466ed2da986e4ba2381c76e8410ba` and the pre-stabilization audited
tree at `ae9f9b04b652976bda4f06cab49a0fa57786c3fa`, in two runs each and in
opposite order. Each run
used 15 samples per operation, a 2,000-line document and one warmup. Cursor
selection setup was flushed through an animation frame before timing; typing
recovery undo was outside its timed interval. Scroll latency includes the next
animation frame. These are local observations, not CI thresholds.

## Electron renderer

Median operation times across the two runs, in milliseconds:

| Operation | Pre-multi-cursor base | Audited branch |
| --- | ---: | ---: |
| Typing | 1.3 | 1.6–2.1 |
| Backspace | 1.3–1.4 | 1.9–2.6 |
| Enter | 2.7–2.8 | 2.6–3.1 |
| Undo | 1.3 | 1.6–2.0 |
| Scroll to next frame, p95 | 17.8–18.0 | 18.2–18.3 |

Typing and Backspace are modestly slower in this renderer comparison; Enter
and scrolling are close. The results do not support claiming zero single-cursor
overhead. They also do not isolate the added controller work from normal
renderer scheduling, and p95 had occasional frame and garbage-collection
outliers. In this sample, one frame dominates the scroll measurement.

Typing latency by active cursor count (median milliseconds, with the two
audited runs shown as a range):

| Cursors | Median typing | Visible secondary caret nodes |
| ---: | ---: | ---: |
| 1 | 2.1–2.6 | 0 |
| 10 | 2.3–3.0 | 0 |
| 100 | 3.0–3.1 | 1 |
| 500 | 6.7–7.0 | 7 |
| 1000 | 10.8–11.8 | 14 |

The 2,000-line viewport exposed at most 14 secondary caret nodes at 1,000
logical cursors, consistent with virtualized overlays. The 1,000-cursor p95
varied from 17.8 to 27.0 ms; occasional lower-count p95 values were also
affected by frame scheduling. Chromium reported a 10,000,000-byte heap snapshot
before and after each run, so this environment did not provide a useful
allocation comparison.

## Transaction-core comparison

The Node fixture reports transaction work without DOM rendering or real line
metrics. On this machine, the 1,000-cursor vertical-add scenario improved from
34.5 ms median / 61.8 ms p95 on the pre-audit multi-cursor implementation to
18.6 ms / 24.2 ms. Excluding occurrences against 1,000 selections improved
from 301.4 ms / 548.8 ms to 9.9 ms / 12.7 ms. These improvements measure the
position and exclusion algorithms only; they are not end-to-end typing times.

The expanded insertion benchmark covers 1, 2, 10, 50, 100, 500 and 1,000
cursors in 100-, 10,000- and 100,000-line fixtures. It records median and p95
and labels its simulated-controller scope in its output. A single-cursor core
comparison on 100,000 lines measured typing at 0.109 ms on the base and
0.113 ms on the audited branch. Simplified fixture timings are sensitive to
garbage collection and should be interpreted alongside the Electron results.

## Reproduction

Run `npm run benchmark:multi-cursor` for the transaction-core grid and
`npm run benchmark:multi-cursor:electron` for the current Electron renderer.
The Electron runner accepts a built application root as an optional argument,
which allows a detached baseline worktree to be measured with the same driver.
The raw JSON outputs are written to stdout; each report includes runtime,
platform, CPU, sample counts and methodology.

## Final stabilization profile

On 2026-10-12, the same Electron driver measured the base, pre-stabilization
commit `ae9f9b04b652976bda4f06cab49a0fa57786c3fa`, and final working tree in
two runs each. It also measured 15 samples of 250 real `setCursorPosition`
calls and instrumented 100 calls to count multi-cursor normalization and
overlay refreshes. The movement loop ran inside the renderer without waiting
for a frame after every call; the separate typing and scroll benchmarks retain
their frame-flushed methodology.

| App | Mono movement median per call | `normalizeSelections` calls / 100 moves | Overlay refresh calls / 100 moves |
| --- | ---: | ---: | ---: |
| Pre-multi-cursor base | 0.0756–0.0776 ms | N/A | N/A |
| Pre-stabilization branch | 0.1384–0.1420 ms | 100 | 100 |
| Final stabilization | 0.1240–0.1276 ms | 0 | 0 |

The mono movement median improved by about 10% against the pre-stabilization
branch in both paired runs. The final renderer still measures about 0.05 ms
more per movement than the base, which has no multi-cursor controller. This
removes repeated work but does not eliminate the controller's remaining
single-cursor cost.

Full typing timings are noisier and do not show a consistent improvement for
single-cursor operations. Across two runs, median single-cursor typing was
1.4–1.6 ms on base, 2.3–2.5 ms pre-stabilization, and 2.3 ms after the pass.
At 500 cursors, median typing was 6.3–6.5 ms before and 5.6–6.1 ms after; at
1,000 cursors it was 9.0–9.2 ms before and 7.9–9.1 ms after. These ranges
overlap at the high end, so they are observations rather than a CI guarantee.

The transaction-core benchmark on a 100,000-line fixture measured one-cursor
typing at 0.108 ms before and 0.113 ms after. At 1,000 cursors the medians were
59.575 ms and 34.587 ms. Each result used five samples; p95 and heap deltas were
variable, so the 1,000-cursor median is a signal to reproduce rather than a
claim of a guaranteed gain. These core measurements omit DOM rendering and do
not isolate the mono-cursor changes.
