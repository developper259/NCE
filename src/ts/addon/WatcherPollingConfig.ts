export const FOREGROUND_INTERVALS = { interval: 400, binaryInterval: 1000 } as const;
export const BACKGROUND_INTERVALS = { interval: 2000, binaryInterval: 5000 } as const;

/** Mirrors awaitWriteFinish.stabilityThreshold in WatcherPollingWorker. */
export const WRITE_SETTLE_MS = 300;

/**
 * Extra room for a poll scan and IPC before the previous worker is closed.
 * Transitions must not close it while a detected change is still settling.
 */
export const TRANSITION_MARGIN_MS = 500;
