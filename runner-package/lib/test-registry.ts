import type { TestContext } from './types.js';

type Hook = (context: TestContext) => Promise<void>;
type TestFn = (context: TestContext) => Promise<void>;

/**
 * Filters usable from a spec file, independent of environment names.
 *
 * `requires` checks capability flags on `env.capabilities` (e.g. `'console'`, `'op'`) —
 * a value of `false` or `'none'` fails the check. `environments` checks the running
 * environment's name directly, for cases that aren't about capability but about the
 * content of a specific stand. See modes-and-plugins §5.4.
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

interface TestCase {
    name: string;
    fn: TestFn;
    requires: string[];
    environments: string[] | null;
}

export const testRegistry: TestCase[] = [];
export const scopeStack: DescribeScope[] = [{ label: '', beforeHooks: [], afterHooks: [] }];

function registerTest(name: string, options: TestOptions, fn: TestFn): void {
    const labels = scopeStack.map(s => s.label).filter(l => l);
    const fullName = [...labels, name].join(' > ');

    const beforeHooks = scopeStack.flatMap(s => s.beforeHooks);
    const afterHooks = [...scopeStack].reverse().flatMap(s => s.afterHooks);

    const wrappedFn = async (ctx: TestContext) => {
        let testError: unknown;
        try {
            for (const hook of beforeHooks) await hook(ctx);
            await fn(ctx);
        } catch (e) {
            testError = e;
        } finally {
            for (const hook of afterHooks) {
                try {
                    await hook(ctx);
                } catch (e) {
                    testError ??= e;
                    console.error('[afterEach] Hook error:', (e as Error).message);
                }
            }
        }
        if (testError) throw testError;
    };

    testRegistry.push({
        name: fullName,
        fn: wrappedFn,
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
