import type { Session } from './session.js';

export class ServerWrapper {
    readonly session: Session;
    /** Default read cursor for `toHaveReceivedMessage` when no `since` is given — the log index
     *  at construction time, so a fresh test only sees lines from its own start. Non-destructive
     *  replacement for the old `session.consoleLog.clear()`: the log itself is never wiped, so
     *  concurrent tests reading it don't race. */
    startIndex: number;

    constructor(session: Session) {
        this.session = session;
        this.startIndex = session.consoleLog.length;
    }

    /** Moves the default read cursor to "now". Used by a `describe.serial` block between its
     *  tests, which share one `ServerWrapper` — the block-level equivalent of a fresh one. */
    resetCursor(): void {
        this.startIndex = this.session.consoleLog.length;
    }

    execute(cmd: string): void {
        if (!this.session.console) {
            throw new Error('No server console available for this environment');
        }
        this.session.console.execute(cmd);
    }

    /** Runs a command and resolves with whatever the console gives back. A console with
     *  `output: 'none'` has nothing to give back and resolves empty. */
    executeAndWait(cmd: string, timeoutMs?: number): Promise<string> {
        if (!this.session.console) {
            throw new Error('No server console available for this environment');
        }
        return this.session.console.executeAndWait(cmd, timeoutMs);
    }
}
