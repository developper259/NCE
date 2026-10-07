(function attachNCEPerformanceMetrics(global) {
  const MAX_ENTRIES = 500;
  const MAX_COUNTERS = 128;
  const MAX_NAME_LENGTH = 80;

  const readClock = () => {
    if (typeof performance !== "undefined" && typeof performance.now === "function")
      return performance.now();
    return Date.now();
  };

  class PerformanceMetrics {
    constructor({ now = readClock } = {}) {
      this.now = now;
      this.entries = new Array(MAX_ENTRIES);
      this.cursor = 0;
      this.entryCount = 0;
      this.sequence = 0;
      this.counters = new Map();
      this.droppedCounters = 0;
      this.resetAt = this.now();
    }

    normalizeName(name) {
      return typeof name === "string" && name.length <= MAX_NAME_LENGTH &&
        /^[A-Za-z][A-Za-z0-9._-]*$/.test(name)
        ? name
        : null;
    }

    push(type, name, value = undefined) {
      const safeName = this.normalizeName(name);
      if (!safeName) return false;
      const entry = {
        sequence: ++this.sequence,
        type,
        name: safeName,
        at: this.now(),
      };
      if (Number.isFinite(value)) entry.value = Math.max(0, value);
      this.entries[this.cursor] = entry;
      this.cursor = (this.cursor + 1) % MAX_ENTRIES;
      this.entryCount = Math.min(this.entryCount + 1, MAX_ENTRIES);
      return true;
    }

    mark(name) {
      return this.push("mark", name);
    }

    begin(name) {
      const safeName = this.normalizeName(name);
      if (!safeName) return null;
      const at = this.now();
      this.push("begin", safeName);
      return { owner: this, name: safeName, at };
    }

    end(token) {
      if (!token || token.owner !== this || !this.normalizeName(token.name) ||
          !Number.isFinite(token.at)) return null;
      const elapsed = Math.max(0, this.now() - token.at);
      this.push("measure", token.name, elapsed);
      return elapsed;
    }

    increment(name, amount = 1) {
      const safeName = this.normalizeName(name);
      if (!safeName || !Number.isFinite(amount)) return false;
      if (!this.counters.has(safeName) && this.counters.size >= MAX_COUNTERS) {
        this.droppedCounters += 1;
        return false;
      }
      const next = (this.counters.get(safeName) || 0) + amount;
      this.counters.set(safeName, Math.max(-1e12, Math.min(1e12, next)));
      return true;
    }

    setGauge(name, value) {
      const safeName = this.normalizeName(name);
      if (!safeName || !Number.isFinite(value)) return false;
      if (!this.counters.has(safeName) && this.counters.size >= MAX_COUNTERS) {
        this.droppedCounters += 1;
        return false;
      }
      this.counters.set(safeName, Math.max(-1e12, Math.min(1e12, value)));
      return true;
    }

    orderedEntries() {
      const first = (this.cursor - this.entryCount + MAX_ENTRIES) % MAX_ENTRIES;
      const ordered = [];
      for (let index = 0; index < this.entryCount; index += 1)
        ordered.push({ ...this.entries[(first + index) % MAX_ENTRIES] });
      return ordered;
    }

    snapshot() {
      const entries = this.orderedEntries();
      const measures = Object.create(null);
      for (const entry of entries) {
        if (entry.type !== "measure") continue;
        const summary = measures[entry.name] || {
          count: 0,
          totalMs: 0,
          maxMs: 0,
          lastMs: 0,
        };
        summary.count += 1;
        summary.totalMs += entry.value;
        summary.maxMs = Math.max(summary.maxMs, entry.value);
        summary.lastMs = entry.value;
        measures[entry.name] = summary;
      }
      for (const summary of Object.values(measures))
        summary.averageMs = summary.count ? summary.totalMs / summary.count : 0;

      return {
        version: 1,
        capacity: MAX_ENTRIES,
        resetAt: this.resetAt,
        eventCount: this.entryCount,
        totalEvents: this.sequence,
        droppedCounters: this.droppedCounters,
        entries,
        counters: Object.fromEntries(this.counters),
        measures,
      };
    }

    reset() {
      this.entries.fill(undefined);
      this.cursor = 0;
      this.entryCount = 0;
      this.sequence = 0;
      this.counters.clear();
      this.droppedCounters = 0;
      this.resetAt = this.now();
      return this.snapshot();
    }
  }

  const metrics = global.NCEPerformanceMetrics instanceof PerformanceMetrics
    ? global.NCEPerformanceMetrics
    : new PerformanceMetrics();
  global.NCEPerformanceMetrics = metrics;
  metrics.mark("renderer.core.loaded");
})(window);
