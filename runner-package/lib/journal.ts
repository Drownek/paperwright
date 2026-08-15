import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

/**
 * A crash-survivable record of one cleanup obligation. Typed and interpreted by a plugin's
 * `cleanup({ scope: 'manual' })` handler — never a raw command string. A journal that
 * replayed arbitrary strings would be a way to run arbitrary commands against a live server
 * the next time someone runs `plugwrightClean<Env>`.
 */
export interface JournalEntry {
    kind: string;
    [key: string]: unknown;
}

/**
 * Append-only log of pending cleanup obligations, for the case where a test's `finally`
 * never runs (SIGKILL, crashed process). `record()`/`forget()` bracket a normal, LIFO
 * `TestContext.cleanup()` finalizer; whatever's still in the file when the process dies
 * survived a crash and is replayed by the next run, or by a manual `plugwrightClean<Env>`.
 *
 * A plain JS closure can't be serialized to a file, so only entries explicitly journaled as
 * a typed record (not a function) survive a crash — this is a lower-level, opt-in companion
 * to `TestContext.cleanup()`, not a transparent upgrade of it.
 */
export class CleanupJournal {
    private readonly path: string | null;
    private readonly pending = new Map<string, JournalEntry>();

    constructor(path: string | null) {
        this.path = path;
        if (!this.path || !existsSync(this.path)) return;

        for (const line of readFileSync(this.path, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const { id, entry } = JSON.parse(line) as { id: string; entry: JournalEntry | null };
                if (entry === null) this.pending.delete(id);
                else this.pending.set(id, entry);
            } catch {
                // A line torn mid-write by a crash. Skip it rather than fail the whole run.
            }
        }
    }

    /** Entries a prior run recorded but never forgot — leftovers from a crash. */
    outstanding(): JournalEntry[] {
        return [...this.pending.values()];
    }

    record(id: string, entry: JournalEntry): void {
        this.pending.set(id, entry);
        this._append({ id, entry });
    }

    forget(id: string): void {
        if (!this.pending.delete(id)) return;
        this._append({ id, entry: null });
    }

    private _append(line: { id: string; entry: JournalEntry | null }): void {
        if (!this.path) return;
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8');
    }
}
