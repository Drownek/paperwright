import type { TestContext } from './types.js';

export type Hook = (context: TestContext) => Promise<void> | void;
type TestFn = (context: TestContext) => Promise<void>;

/**
 * Filters usable from a spec file, independent of environment names.
 *
 * `requires` checks capability flags on `env.capabilities` (e.g. `'console'`, `'op'`) —
 * a value of `false` or `'none'` fails the check. `environments` checks the running
 * environment's name directly, for cases that aren't about capability but about the
 * content of a specific stand.
 */
export interface TestOptions {
    requires?: string[];
    environments?: string[];
    /** Runs this many independent instances of the test concurrently, each with its own bot
     *  leased from the account pool, to exercise races between players hitting the same feature
     *  at once. One failing instance fails the whole test. Defaults to 1 (sequential, no pool
     *  requirement). Validated against the pool's capacity before any test runs. */
    concurrency?: number;
}

interface DescribeScope {
    label: string;
    beforeHooks: Hook[];
    afterHooks: Hook[];
}

export interface TestCase {
    name: string;
    fn: TestFn;
    /** Spec-level `beforeEach` hooks in run order (outermost `describe` first). */
    beforeHooks: Hook[];
    /** Spec-level `afterEach` hooks in run order (innermost `describe` first) — already
     *  reversed at registration time, see `registerTest`. */
    afterHooks: Hook[];
    requires: string[];
    environments: string[] | null;
    concurrency: number;
}

/** What a `describe.serial` block accepts beyond the usual filters. */
export interface SerialOptions extends TestOptions {
    /** Run the whole block on this pool account instead of whichever one is free. For a stand
     *  where one specific account is the one carrying the state a test needs — a permission
     *  group, a starting balance. Fails the block on an environment with no account pool. */
    account?: string;
}

/** A `describe.serial` block: its tests run in declaration order, on one player, and the block
 *  is what the runner schedules and filters — not the tests inside it. */
export interface SerialBlock {
    name: string;
    account: string | null;
    tests: TestCase[];
    requires: string[];
    environments: string[] | null;
    concurrency: number;
}

export type RegistryItem =
    | { kind: 'test'; testCase: TestCase }
    | { kind: 'serial'; block: SerialBlock };

export const testRegistry: RegistryItem[] = [];
export const scopeStack: DescribeScope[] = [{ label: '', beforeHooks: [], afterHooks: [] }];

/** The `describe.serial` block being registered, if any. Tests declared while it is set go
 *  into it instead of straight into `testRegistry`. */
let currentBlock: SerialBlock | null = null;

/** Discards whatever a previously-imported spec file registered, ready for the next one.
 *  `testRegistry`/`scopeStack` stay module-level with this per-file reset — correct only
 *  as long as one process runs one environment and files run sequentially. */
export function resetRegistry(): void {
    testRegistry.length = 0;
    scopeStack.length = 0;
    scopeStack.push({ label: '', beforeHooks: [], afterHooks: [] });
    currentBlock = null;
}

/** Everything a registered test needs from the current `describe` scope. */
function scopedEntry(name: string, options: TestOptions) {
    const labels = scopeStack.map(s => s.label).filter(l => l);
    return {
        name: [...labels, name].join(' > '),
        beforeHooks: scopeStack.flatMap(s => s.beforeHooks),
        afterHooks: [...scopeStack].reverse().flatMap(s => s.afterHooks),
        requires: options.requires ?? [],
        environments: options.environments ?? null,
        concurrency: normalizeConcurrency(options.concurrency),
    };
}

/** `concurrency` must be a whole number of at least 1 — anything else can't be turned into a
 *  bot count. Checked at registration time so a typo fails on import, not mid-run. */
function normalizeConcurrency(concurrency: number | undefined): number {
    if (concurrency === undefined) return 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error(`concurrency must be a whole number >= 1, got ${concurrency}`);
    }
    return concurrency;
}

function registerTest(name: string, options: TestOptions, fn: TestFn): void {
    const testCase = { ...scopedEntry(name, options), fn };
    if (currentBlock) {
        // A serial block always runs its tests one after another on the same player — fanning
        // one of them out into concurrent instances makes no sense and would otherwise be
        // silently ignored (the block runner never reads a per-test concurrency), leaving
        // whoever set it wondering why nothing ran concurrently.
        if (testCase.concurrency > 1) {
            throw new Error(
                `test "${name}": concurrency is not supported on tests inside describe.serial ` +
                `(block "${currentBlock.name}") — set concurrency on the describe.serial block itself instead.`
            );
        }
        currentBlock.tests.push(testCase);
    } else {
        testRegistry.push({ kind: 'test', testCase });
    }
}

export function test(name: string, fn: TestFn): void;
export function test(name: string, options: TestOptions, fn: TestFn): void;
export function test(name: string, fnOrOptions: TestFn | TestOptions, maybeFn?: TestFn): void {
    if (typeof fnOrOptions === 'function') {
        registerTest(name, {}, fnOrOptions);
    } else {
        registerTest(name, fnOrOptions, maybeFn!);
    }
}

export function opTest(name: string, fn: TestFn): void;
export function opTest(name: string, options: TestOptions, fn: TestFn): void;
export function opTest(name: string, fnOrOptions: TestFn | TestOptions, maybeFn?: TestFn): void {
    const options = typeof fnOrOptions === 'function' ? {} : fnOrOptions;
    const fn = typeof fnOrOptions === 'function' ? fnOrOptions : maybeFn!;
    registerTest(name, options, async (context: TestContext) => {
        await context.player.makeOp();
        await fn(context);
    });
}

function describeImpl(label: string, fn: () => void): void {
    scopeStack.push({ label, beforeHooks: [], afterHooks: [] });
    try {
        fn();
    } finally {
        scopeStack.pop();
    }
}

/**
 * Registers a block whose tests run in the order they are declared, against one player that
 * stays connected for the whole block — the shape a scenario needs when one step only means
 * something after the one before it ("claim a kit, see it on cooldown, see the cooldown
 * expire"). Everything outside such a block is still an independent test with its own bot.
 *
 * The block, not the test, is what filters apply to: `requires`, `environments` and the run's
 * name filters are checked against every test in it, and one exclusion skips the whole block
 * rather than leaving a broken chain behind. A failing test skips the rest of its block for the
 * same reason — the tests after it were written to run on what it was supposed to leave.
 *
 * Plugin `beforeEach`/`afterEach` run once around the block, not around each test in it: a
 * plugin that resets an account between tests would undo exactly what the block is built on.
 * `beforeEach`/`afterEach` declared in the spec still run for every test.
 */
function serialImpl(label: string, optionsOrFn: SerialOptions | (() => void), maybeFn?: () => void): void {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn!;

    if (currentBlock) {
        throw new Error(`describe.serial: "${label}" is nested inside serial block "${currentBlock.name}" — a block cannot contain another`);
    }

    const labels = scopeStack.map(s => s.label).filter(l => l);
    const block: SerialBlock = {
        name: [...labels, label].join(' > '),
        account: options.account ?? null,
        tests: [],
        requires: options.requires ?? [],
        environments: options.environments ?? null,
        concurrency: normalizeConcurrency(options.concurrency),
    };

    currentBlock = block;
    scopeStack.push({ label, beforeHooks: [], afterHooks: [] });
    try {
        fn();
    } finally {
        scopeStack.pop();
        currentBlock = null;
    }

    testRegistry.push({ kind: 'serial', block });
}

interface DescribeApi {
    (label: string, fn: () => void): void;
    serial(label: string, fn: () => void): void;
    serial(label: string, options: SerialOptions, fn: () => void): void;
}

export const describe: DescribeApi = Object.assign(describeImpl, { serial: serialImpl });

export function beforeEach(hook: Hook): void {
    scopeStack[scopeStack.length - 1].beforeHooks.push(hook);
}

export function afterEach(hook: Hook): void {
    scopeStack[scopeStack.length - 1].afterHooks.push(hook);
}
