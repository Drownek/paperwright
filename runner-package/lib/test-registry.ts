import type { TestContext } from './types.js';
import type { ReuseOptions } from './player-registry.js';

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
    /** How this test wants its player resolved when `tests.reuse` is on. `false` forces a
     *  fresh connection regardless of the run's reuse setting — for a test that depends on a
     *  brand-new nick or the absence of a label another test might have left behind. A string
     *  is shorthand for `{ key }`. Omitted means "match by ability labels", the default.
     *  `{ stay }` decides whether the player this test used keeps its connection afterwards,
     *  overriding the run's `tests.reuse.stay` for this test alone. */
    reuse?: false | string | ReuseOptions;
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
    reuse?: false | string | ReuseOptions;
}

export const testRegistry: TestCase[] = [];
export const scopeStack: DescribeScope[] = [{ label: '', beforeHooks: [], afterHooks: [] }];

/** Discards whatever a previously-imported spec file registered, ready for the next one.
 *  `testRegistry`/`scopeStack` stay module-level with this per-file reset — correct only
 *  as long as one process runs one environment and files run sequentially. */
export function resetRegistry(): void {
    testRegistry.length = 0;
    scopeStack.length = 0;
    scopeStack.push({ label: '', beforeHooks: [], afterHooks: [] });
}

function registerTest(name: string, options: TestOptions, fn: TestFn): void {
    const labels = scopeStack.map(s => s.label).filter(l => l);
    const fullName = [...labels, name].join(' > ');

    testRegistry.push({
        name: fullName,
        fn,
        beforeHooks: scopeStack.flatMap(s => s.beforeHooks),
        afterHooks: [...scopeStack].reverse().flatMap(s => s.afterHooks),
        requires: options.requires ?? [],
        environments: options.environments ?? null,
        reuse: options.reuse,
    });
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

/** Appends `abilities: ['op']` to whatever `reuse` the test declared (or the implicit `{}`),
 *  so a reused player is matched by op status same as a fresh one gets opped. */
function withOpAbility(reuse: TestOptions['reuse']): ReuseOptions {
    const base: ReuseOptions = reuse === false ? {} : reuse === undefined ? {} : typeof reuse === 'string' ? { key: reuse } : reuse;
    return { ...base, abilities: [...(base.abilities ?? []), 'op'] };
}

export function opTest(name: string, fn: TestFn): void;
export function opTest(name: string, options: TestOptions, fn: TestFn): void;
export function opTest(name: string, fnOrOptions: TestFn | TestOptions, maybeFn?: TestFn): void {
    const options = typeof fnOrOptions === 'function' ? {} : fnOrOptions;
    const fn = typeof fnOrOptions === 'function' ? fnOrOptions : maybeFn!;
    registerTest(name, { ...options, reuse: options.reuse === false ? false : withOpAbility(options.reuse) }, async (context: TestContext) => {
        // Only when the resolved player doesn't already carry it: resolution above already
        // matched on `op`, so a reused player skips straight to the test body.
        if (!context.player.abilities.has('op')) await context.player.makeOp();
        await fn(context);
    });
}

export function describe(label: string, fn: () => void): void {
    scopeStack.push({ label, beforeHooks: [], afterHooks: [] });
    try {
        fn();
    } finally {
        scopeStack.pop();
    }
}

export function beforeEach(hook: Hook): void {
    scopeStack[scopeStack.length - 1].beforeHooks.push(hook);
}

export function afterEach(hook: Hook): void {
    scopeStack[scopeStack.length - 1].afterHooks.push(hook);
}
