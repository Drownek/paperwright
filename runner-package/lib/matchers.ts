import { Matchers } from './expect.js';
import { PlayerWrapper } from './player.js';
import { ServerWrapper } from './server.js';
import { GuiItemLocator } from './wrappers.js';
import { sleep } from './utils.js';

export class RunnerMatchers<T = unknown> extends Matchers<T> {
    constructor(actual: T, isNot: boolean = false) {
        super(actual, isNot);
    }

    /**
     * Unwraps a rejected Promise so subsequent matchers run against the error.
     */
    get rejects() {
        return {
            toThrow: async (expected?: string | RegExp) => {
                try {
                    await (this.actual as Promise<any>);
                } catch (err: any) {
                    if (expected === undefined) return;
                    const msg = err?.message ?? String(err);
                    if (typeof expected === 'string') {
                        this._assert(
                            msg.includes(expected),
                            `Expected rejection not to include "${expected}", but got "${msg}"`,
                            `Expected rejection to include "${expected}", but got "${msg}"`
                        );
                    } else {
                        this._assert(
                            expected.test(msg),
                            `Expected rejection not to match ${expected}, but got "${msg}"`,
                            `Expected rejection to match ${expected}, but got "${msg}"`
                        );
                    }
                    return;
                }
                this._assert(false, 'Expected promise to resolve, but it rejected', 'Expected promise to reject, but it resolved');
            }
        };
    }

    protected async pollAssertion(
        condition: () => boolean,
        passMessage: () => string,
        failMessage: () => string,
        options: { timeout?: number; pollingRate?: number } = {}
    ): Promise<void> {
        const { timeout = 5000, pollingRate = 50 } = options;
        const expected = !this.isNot;
        const deadline = Date.now() + timeout;

        // Deadline last, as in `poll`: the condition is checked once more after the final
        // wait, so a message that lands during it still counts.
        for (;;) {
            if (condition() === expected) return;
            if (Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, pollingRate));
        }

        throw new Error(this.isNot ? passMessage() : failMessage());
    }

    /**
     * Waits for the player or server console to receive a message matching the expected text or pattern.
     *
     * ### Concurrency & Isolation Guidance:
     * - **`expect(player)`**: Checks `player.messageBuffer`, which is strictly isolated per bot.
     *   Always prefer `expect(player)` when asserting on chat, notifications, or feedback addressed to a player.
     *   It is completely safe from race conditions in concurrent tests (`concurrency: N`).
     * - **`expect(server)`**: Reads `session.consoleLog`, which is a single shared stream for the entire server.
     *   In concurrent test execution (`concurrency: N`), lines from other bots appear in this log simultaneously.
     *   When asserting on server logs under concurrency, always qualify patterns with `${player.username}`
     *   (e.g. `new RegExp(`Gave 100 to ${player.username}`)`) or narrow the search window with `options.since`.
     *   For global assertions without a player identifier (e.g. `[Plugin] Reload complete`), run the test without
     *   the `concurrency` option as a standard, single-runner test.
     */
    async toHaveReceivedMessage(
        this: RunnerMatchers<PlayerWrapper | ServerWrapper>,
        expectedMessage: string | RegExp,
        options: { strict?: boolean; timeout?: number; pollingRate?: number; since?: number } = {}
    ): Promise<void> {
        const { strict = false, timeout, pollingRate, since } = options;
        const isMatch = (msg: string): boolean => {
            if (expectedMessage instanceof RegExp) return expectedMessage.test(msg);
            return strict ? msg === expectedMessage : msg.includes(expectedMessage);
        };

        const session = (this.actual as PlayerWrapper | ServerWrapper).session;

        // Reading the server log needs a console that streams everything. A console that only
        // answers the commands it is given (RCON) leaves the buffer empty, and the assertion
        // would fail after a full timeout with nothing explaining why.
        if (!(this.actual instanceof PlayerWrapper) && session.env.capabilities.consoleOutput !== 'full') {
            throw new Error(
                `Cannot read the server log on environment "${session.env.id}": its console output level is ` +
                `"${session.env.capabilities.consoleOutput}". Mark the test with requires: ['consoleOutput:full'] ` +
                'to have it skipped there instead.'
            );
        }

        // A player's messages are its own (see `PlayerWrapper.messageBuffer`) so one bot's chat
        // never satisfies an assertion made against another; the server log has no such split,
        // it's one console shared by the whole session — and never cleared, so a test that
        // doesn't pass `since` defaults to its own `ServerWrapper.startIndex` instead of 0.
        const buffer = this.actual instanceof PlayerWrapper
            ? this.actual.messageBuffer
            : session.consoleLog;
        const effectiveSince = since ?? (this.actual instanceof PlayerWrapper ? undefined : this.actual.startIndex);
        const view = (): string[] => buffer.slice(effectiveSince);

        await this.pollAssertion(
            () => view().some(isMatch),
            () => `Expected NOT to receive message matching "${expectedMessage}", but received: "${view().find(isMatch)}"`,
            () => `Expected message matching "${expectedMessage}" not received`,
            { timeout, pollingRate }
        );
    }

    async toContainItem(
        this: RunnerMatchers<PlayerWrapper>,
        itemName: string,
        options: { count?: number; timeout?: number; pollingRate?: number } = {}
    ): Promise<void> {
        const { count, timeout, pollingRate } = options;
        const bot = this.actual.bot;

        const getItems = () => bot.inventory.items().filter(i => i.name.includes(itemName));
        const getTotal = () => getItems().reduce((sum, i) => sum + i.count, 0);

        const condition = () => {
            const items = getItems();
            if (items.length === 0) return false;
            if (count !== undefined) return getTotal() >= count;
            return true;
        };

        await this.pollAssertion(
            condition,
            () => count !== undefined
                ? `Expected inventory NOT to contain ${count}x "${itemName}", but found ${getTotal()}`
                : `Expected inventory NOT to contain "${itemName}", but found: "${getItems()[0]?.name}"`,
            () => count !== undefined
                ? `Expected ${count}x "${itemName}" in inventory, but found ${getTotal()}`
                : `Expected item "${itemName}" in inventory`,
            { timeout, pollingRate }
        );
    }

    async toHaveLore(
        this: RunnerMatchers<GuiItemLocator>,
        expectedLore: string,
        options: { timeout?: number; pollingRate?: number } = {}
    ): Promise<void> {
        const { timeout = 5000, pollingRate = 100 } = options;
        const locator = this.actual;

        await this.pollAssertion(
            () => locator.loreText().includes(expectedLore),
            () => `Expected locator NOT to have lore containing "${expectedLore}", but got: "${locator.loreText()}"`,
            () => `Expected locator to have lore containing "${expectedLore}", but got: "${locator.loreText()}"`,
            { timeout, pollingRate }
        );
    }

    async toBeNear(
        this: RunnerMatchers<PlayerWrapper>,
        x: number,
        y: number | undefined,
        z: number,
        options: { tolerance?: number; timeout?: number } = {}
    ): Promise<void> {
        const { tolerance = 1, timeout = 5000 } = options;
        const player = this.actual;
        const pos = () => player.bot.entity.position;

        const isNear = () =>
            Math.abs(pos().x - x) <= tolerance &&
            Math.abs(pos().z - z) <= tolerance &&
            (y === undefined || Math.abs(pos().y - y) <= tolerance);

        const targetStr = y !== undefined
            ? `(${x}, ${y}, ${z})`
            : `(${x}, *, ${z})`;

        const posStr = () => y !== undefined
            ? `(${pos().x.toFixed(2)}, ${pos().y.toFixed(2)}, ${pos().z.toFixed(2)})`
            : `(${pos().x.toFixed(2)}, *, ${pos().z.toFixed(2)})`;

        await this.pollAssertion(
            isNear,
            () => `Expected player NOT to be near ${targetStr}, but was at ${posStr()}`,
            () => `Expected player to be near ${targetStr}, but was at ${posStr()}`,
            { timeout }
        );
    }

    async toBeNearXZ(
        this: RunnerMatchers<PlayerWrapper>,
        x: number,
        z: number,
        options: { tolerance?: number; timeout?: number } = {}
    ): Promise<void> {
        return this.toBeNear(x, undefined, z, options);
    }
}

interface PollOptions {
    timeout?: number;
    interval?: number;
    message?: string;
}

export class PollMatchers<T> {
    private readonly fn: () => T | Promise<T>;
    private readonly options: Required<Omit<PollOptions, 'message'>> & { message?: string };
    private readonly isNot: boolean;

    constructor(fn: () => T | Promise<T>, options: PollOptions = {}, isNot: boolean = false) {
        this.fn = fn;
        this.options = { timeout: 5000, interval: 250, ...options };
        this.isNot = isNot;
    }

    get not(): PollMatchers<T> {
        return new PollMatchers(this.fn, this.options, !this.isNot);
    }

    private async pollUntilPass(assertion: (matchers: Matchers<T>) => void | Promise<void>): Promise<void> {
        const { timeout, interval } = this.options;
        const deadline = Date.now() + timeout;
        let lastError: unknown;

        // Deadline last, as in `poll`: one more attempt after the final wait.
        for (;;) {
            const value = await this.fn();
            try {
                const m = new Matchers(value, this.isNot);
                await assertion(m);
                return;
            } catch (e) {
                lastError = e;
            }
            if (Date.now() >= deadline) break;
            await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
        }

        if (this.options.message) {
            throw new Error(this.options.message);
        }
        throw lastError;
    }

    toBe(expected: any): Promise<void> {
        return this.pollUntilPass(m => m.toBe(expected));
    }
    toEqual(expected: any): Promise<void> {
        return this.pollUntilPass(m => m.toEqual(expected));
    }
    toBeTruthy(): Promise<void> {
        return this.pollUntilPass(m => m.toBeTruthy());
    }
    toBeFalsy(): Promise<void> {
        return this.pollUntilPass(m => m.toBeFalsy());
    }
    toBeNull(): Promise<void> {
        return this.pollUntilPass(m => m.toBeNull());
    }
    toBeUndefined(): Promise<void> {
        return this.pollUntilPass(m => m.toBeUndefined());
    }
    toBeDefined(): Promise<void> {
        return this.pollUntilPass(m => m.toBeDefined());
    }
    toBeNaN(): Promise<void> {
        return this.pollUntilPass(m => m.toBeNaN());
    }
    toBeGreaterThan(expected: number): Promise<void> {
        return this.pollUntilPass(m => (m as Matchers<number>).toBeGreaterThan(expected));
    }
    toBeGreaterThanOrEqual(expected: number): Promise<void> {
        return this.pollUntilPass(m => (m as Matchers<number>).toBeGreaterThanOrEqual(expected));
    }
    toBeLessThan(expected: number): Promise<void> {
        return this.pollUntilPass(m => (m as Matchers<number>).toBeLessThan(expected));
    }
    toBeLessThanOrEqual(expected: number): Promise<void> {
        return this.pollUntilPass(m => (m as Matchers<number>).toBeLessThanOrEqual(expected));
    }
    toBeCloseTo(expected: number, precision?: number): Promise<void> {
        return this.pollUntilPass(m => (m as Matchers<number>).toBeCloseTo(expected, precision));
    }
    toContain(item: any): Promise<void> {
        return this.pollUntilPass(m => m.toContain(item));
    }
    toContainEqual(item: any): Promise<void> {
        return this.pollUntilPass(m => m.toContainEqual(item));
    }
    toHaveLength(expected: number): Promise<void> {
        return this.pollUntilPass(m => m.toHaveLength(expected));
    }
    toHaveProperty(keyPath: string | string[], value?: any): Promise<void> {
        return this.pollUntilPass(m => m.toHaveProperty(keyPath, value));
    }
    toMatch(expected: string | RegExp): Promise<void> {
        return this.pollUntilPass(m => m.toMatch(expected));
    }
    toMatchObject(expected: any): Promise<void> {
        return this.pollUntilPass(m => m.toMatchObject(expected));
    }
    toBeInstanceOf(expected: Function): Promise<void> {
        return this.pollUntilPass(m => m.toBeInstanceOf(expected));
    }
    toThrow(expected?: string | RegExp | Function): Promise<void> {
        return this.pollUntilPass(m => m.toThrow(expected));
    }
    toThrowAsync(expected?: string | RegExp | Function): Promise<void> {
        return this.pollUntilPass(m => m.toThrowAsync(expected));
    }
}

interface PollOptionsForExpect {
    timeout?: number;
    interval?: number;
    message?: string;
}

interface ExpectFunction {
    <T>(target: T): RunnerMatchers<T>;
    poll: <T>(fn: () => T | Promise<T>, options?: PollOptionsForExpect) => PollMatchers<T>;
}

export const expect: ExpectFunction = Object.assign(
    <T>(target: T): RunnerMatchers<T> => new RunnerMatchers(target),
    {
        poll: <T>(fn: () => T | Promise<T>, options?: PollOptionsForExpect): PollMatchers<T> =>
            new PollMatchers(fn, options),
    }
);