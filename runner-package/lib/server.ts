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
}
