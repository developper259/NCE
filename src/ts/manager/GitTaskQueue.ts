/** Bounds concurrent Git work so a renderer burst cannot spawn unbounded processes. */
export class GitTaskQueue {
  private active = 0;
  private readonly pending: Array<{
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(private readonly limit: number = 1) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError("GitTaskQueue limit must be a positive integer.");
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        task,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.active;
  }

  private pump(): void {
    while (this.active < this.limit && this.pending.length) {
      const entry = this.pending.shift()!;
      this.active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}
