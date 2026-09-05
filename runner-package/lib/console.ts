/**
 * A channel for sending admin commands to the server and reading its output.
 * `local` speaks to the Paper process over stdio; other channels (RCON, an
 * admin bot) are added by later modes.
 */
export interface ServerConsole {
    readonly kind: 'stdio' | 'rcon';
    /** How much of the server's output this channel can see. Matchers must check this,
     *  not just whether a console exists, or tests silently stop working on `'responses'`/`'none'`. */
    readonly output: 'full' | 'responses' | 'none';
    probe(): Promise<boolean>;
    execute(cmd: string): void;
    executeAndWait(cmd: string, timeoutMs?: number): Promise<string>;
}
