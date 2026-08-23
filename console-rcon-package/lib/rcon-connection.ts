import { createConnection, Socket } from 'net';
import { PacketType, decodePacketBody, encodePacket } from './protocol.js';

interface Waiter {
    resolve: (payload: string) => void;
    reject: (error: Error) => void;
}

/**
 * One authenticated RCON connection: connects and authenticates lazily on first use,
 * reassembles the length-prefixed packet stream, and matches responses back to callers by
 * request id. Reconnects on the next call after the socket closes — an RCON server dropping
 * an idle connection is normal, not a hard failure.
 */
export class RconConnection {
    private socket: Socket | null = null;
    private connectPromise: Promise<void> | null = null;
    private inbound: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    private nextId = 1;
    private pendingAuth: Waiter | null = null;
    private readonly pending = new Map<number, Waiter>();

    constructor(
        private readonly host: string,
        private readonly port: number,
        private readonly password: string,
    ) {}

    async ensureConnected(): Promise<void> {
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = new Promise<void>((resolve, reject) => {
            const socket = createConnection({ host: this.host, port: this.port });
            this.socket = socket;

            socket.once('connect', () => {
                this.pendingAuth = {
                    resolve: () => resolve(),
                    reject: (err) => reject(err),
                };
                const id = this.nextId++;
                socket.write(encodePacket(id, PacketType.AUTH, this.password));
            });

            socket.on('data', (chunk) => this.onData(chunk));

            socket.once('error', (err) => {
                this.connectPromise = null;
                reject(err);
            });

            socket.once('close', () => {
                this.connectPromise = null;
                this.socket = null;
                const closedError = new Error('RCON connection closed');
                this.pendingAuth?.reject(closedError);
                this.pendingAuth = null;
                for (const waiter of this.pending.values()) waiter.reject(closedError);
                this.pending.clear();
            });
        });

        return this.connectPromise;
    }

    private onData(chunk: Buffer): void {
        this.inbound = this.inbound.length > 0 ? Buffer.concat([this.inbound, chunk]) : chunk;

        while (this.inbound.length >= 4) {
            const size = this.inbound.readInt32LE(0);
            if (this.inbound.length < 4 + size) break;

            const body = this.inbound.subarray(4, 4 + size);
            this.inbound = this.inbound.subarray(4 + size);
            this.handlePacket(decodePacketBody(body));
        }
    }

    private handlePacket(packet: { id: number; type: number; payload: string }): void {
        if (packet.type === PacketType.AUTH_RESPONSE && this.pendingAuth) {
            const waiter = this.pendingAuth;
            this.pendingAuth = null;
            if (packet.id === -1) waiter.reject(new Error('RCON authentication failed: wrong password'));
            else waiter.resolve('');
            return;
        }

        const waiter = this.pending.get(packet.id);
        if (waiter) {
            this.pending.delete(packet.id);
            waiter.resolve(packet.payload);
        }
    }

    async executeAndWait(cmd: string, timeoutMs: number): Promise<string> {
        await this.ensureConnected();
        const socket = this.socket;
        if (!socket) throw new Error('RCON connection is not open');

        const id = this.nextId++;
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RCON command timed out after ${timeoutMs}ms: ${cmd}`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: (payload) => { clearTimeout(timer); resolve(payload); },
                reject: (err) => { clearTimeout(timer); reject(err); },
            });

            socket.write(encodePacket(id, PacketType.EXECCOMMAND, cmd));
        });
    }

    execute(cmd: string): void {
        this.executeAndWait(cmd, 5000).catch((error: Error) => {
            console.error(`[rcon] command failed: ${cmd}: ${error.message}`);
        });
    }
}
