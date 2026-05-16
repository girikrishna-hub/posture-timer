/**
 * AuthOperationQueue — serializes auth mutations.
 *
 * Only ONE auth operation runs at a time. Concurrent callers wait their turn.
 * Operations can be tagged so duplicates can be deduplicated by tag.
 *
 * Prevents:
 *   - refresh storms (duplicate concurrent refresh calls)
 *   - duplicate sign-in attempts
 *   - overlapping lifecycle recovery operations
 */

export type QueuedOperation<T> = () => Promise<T>;

interface Slot {
  tag: string | null;
  promise: Promise<unknown>;
}

interface QueueEntry {
  tag: string | null;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  promise: Promise<unknown>;
}

export class AuthOperationQueue {
  private _running: Slot | null = null;
  private _queue: Array<QueueEntry> = [];

  /**
   * Enqueue an operation. If an operation with the same tag is already
   * in-flight or queued, returns that operation's promise instead (dedup).
   */
  enqueue<T>(op: QueuedOperation<T>, tag?: string): Promise<T> {
    // Dedup: if same tag is already running, return its promise.
    if (tag && this._running?.tag === tag) {
      return this._running.promise as Promise<T>;
    }
    // Dedup: if same tag is in the queue, return its promise.
    if (tag) {
      const existing = this._queue.find((e) => e.tag === tag);
      if (existing) return existing.promise as Promise<T>;
    }

    let entry!: QueueEntry;
    const p = new Promise<T>((resolve, reject) => {
      entry = {
        tag: tag ?? null,
        run: op as QueuedOperation<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        promise: null as unknown as Promise<unknown>,
      };
      this._queue.push(entry);
    });
    entry.promise = p;

    this._drain();
    return p;
  }

  get isIdle(): boolean {
    return this._running === null && this._queue.length === 0;
  }

  get pendingCount(): number {
    return this._queue.length + (this._running ? 1 : 0);
  }

  private _drain(): void {
    if (this._running || this._queue.length === 0) return;
    const next = this._queue.shift()!;
    const promise = next.run().then(
      (v) => { next.resolve(v); },
      (e) => { next.reject(e); },
    ).finally(() => {
      this._running = null;
      this._drain();
    });
    this._running = { tag: next.tag, promise };
  }
}
