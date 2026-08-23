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
