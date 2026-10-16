import type { AtomCommandResult } from "@goat/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly canPersist?: () => boolean;
  /** Null cancels a queued write whose draft was discarded. */
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E> | null>;
  readonly onPendingChange: (pending: boolean) => void;
  /** Return false when another editor has newer unsaved contents. */
  readonly onConfirmed: (contents: string) => boolean | void;
}

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private confirmedRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    if (this.disposed) return;
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  retry(): void {
    if (this.disposed) return;
    this.clearTimer();
    void this.persistLatest();
  }

  discard(): void {
    this.clearTimer();
    this.confirmedRevision = this.latestRevision;
    this.options.onPendingChange(false);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === this.confirmedRevision) return;
    if (this.options.canPersist?.() === false) {
      return;
    }

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    if (result === null) {
      this.saving = false;
      return;
    }
    const succeeded = result._tag === "Success";
    let confirmed = false;
    if (succeeded) {
      this.confirmedRevision = revision;
      confirmed = this.options.onConfirmed(contents) !== false;
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (confirmed) this.options.onPendingChange(false);
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }
}

export type FileSaveStatus =
  | "saved"
  | "unsaved"
  | "saving"
  | "failed"
  | "changed"
  | "deleted"
  | "reloading"
  | "reloadFailed";

/** File-owned state survives replacement of source and Markdown editors. */
export class FileSaveSession {
  status: FileSaveStatus = "saved";
  overwrite = false;
  generation = 0;
  readonly coordinators = new Set<FileSaveCoordinator>();
  private pending = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getStatus = () => this.status;

  get blocked() {
    return (
      this.status === "changed" ||
      this.status === "deleted" ||
      this.status === "reloading" ||
      this.status === "reloadFailed"
    );
  }

  requestOverwrite(): boolean {
    if (!this.blocked || this.status === "reloading") return false;
    this.overwrite = true;
    this.setStatus("unsaved");
    return true;
  }

  takeOverwrite(): boolean {
    const overwrite = this.overwrite;
    this.overwrite = false;
    return overwrite;
  }

  setStatus(status: FileSaveStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  enqueue<A>(run: () => Promise<A>): Promise<A> {
    const next = this.pending.then(run);
    this.pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  discard(): void {
    this.generation += 1;
    this.overwrite = false;
    for (const coordinator of this.coordinators) coordinator.discard();
    this.setStatus("saved");
  }
}
