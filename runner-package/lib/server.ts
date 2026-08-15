import type { Session } from './session.js';

export class ServerWrapper {
    readonly session: Session;

    constructor(session: Session) {
        this.session = session;
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
