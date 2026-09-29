# Highlight scroll microbenchmark

Run only the dedicated warm-highlight and plain-text scroll comparison:

```sh
npm run benchmark:highlight-scroll -- \
  --scenario highlight.scroll-warm,highlight.scroll-plain-control \
  --samples 20 --warmups 1 \
  --output .benchmark-data/ide/results/highlight-warm.json
```

The runner generates one deterministic 1,400-line JavaScript fixture. Before
each warm sample it waits for the file load, selects incremental document
highlighting, tokenizes the whole file in batches, and fails unless every line
has cached tokens. Prewarming is excluded from the measured scroll window. The
plain control uses the same fixture and scroll pattern after temporarily
switching the open file to plain text for that sample.

Each JSON report includes the frame intervals and long tasks for every sample,
plus row recycling, highlighted row rebuilds, cache hits/misses, token
projection, span creation/removal, DOM commits, renderer requests, and geometry
reads. Browser-internal style, layout, and paint timings are not inferred from
these renderer counters.
