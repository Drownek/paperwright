export const sleep = (ms: number, signal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Aborted'));
        const timeout = setTimeout(resolve, ms);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timeout);
                reject(new Error('Aborted'));
            }, { once: true });
        }
    });
};

/**
 * Polls `fn` until it returns a non-undefined value, or throws on timeout.
 *
 * The deadline is checked *after* `fn` runs, never instead of it: the last thing this does
 * before giving up is look one more time. Checking the clock first discards whatever landed
 * during the final sleep, and that window is not the 50ms it looks like — a bot loading
 * chunks stalls the event loop for seconds, and when it comes back the value that would have
 * passed the poll is already there while the clock is past the deadline. That failure reads
 * as "the message arrived and the wait timed out anyway", which is exactly as confusing as
 * it sounds.
 */
export async function poll<T>(
    fn: () => T | undefined | Promise<T | undefined>,
    options: {
        timeout?: number;
        interval?: number;
        message?: string | (() => string);
        signal?: AbortSignal;
    } = {}
): Promise<T> {
    const { timeout = 5000, interval = 50, message = 'poll() timed out', signal } = options;
    const deadline = Date.now() + timeout;

    for (;;) {
        if (signal?.aborted) throw new Error('Aborted');
        const result = await fn();
        if (result !== undefined) return result;
        if (Date.now() >= deadline) break;
        await sleep(interval, signal);
    }

    throw new Error(`Timeout: ${typeof message === 'function' ? message() : message}`);
}

/**
 * Polls `fn` until it resolves without throwing, or the timeout elapses.
 * Useful for assertions that may not be immediately true.
 */
export async function waitForAssertion(
    fn: () => Promise<void>,
    { timeout = 5000, interval = 250, signal }: { timeout?: number, interval?: number, signal?: AbortSignal } = {}
): Promise<void> {
    const deadline = Date.now() + timeout;
    let lastError: unknown;

    // Deadline last, as in `poll`: the final attempt happens after the final sleep.
    for (;;) {
        if (signal?.aborted) throw new Error('Aborted');
        try {
            await fn();
            return; // passed
        } catch (e) {
            lastError = e;
        }
        if (Date.now() >= deadline) break;
        await sleep(interval, signal);
    }
    throw lastError;
}

/**
 * Polls `predicate` until it returns `true`, or the timeout elapses.
 * Useful for waiting on a condition that may not be immediately true.
 *
 * @throws {Error} if the condition is not met within the timeout.
 */
export async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    {
        timeout = 5000,
        interval = 250,
        message = "waitUntil timed out: condition was not met",
        signal
    }: { timeout?: number, interval?: number, message?: string, signal?: AbortSignal } = {}
): Promise<void> {
    const deadline = Date.now() + timeout;

    // Deadline last, as in `poll`: the final check happens after the final sleep.
    for (;;) {
        if (signal?.aborted) throw new Error('Aborted');
        if (await predicate()) {
            return; // condition met
        }
        if (Date.now() >= deadline) break;
        await sleep(interval, signal);
    }

    throw new Error(message);
}

/**
 * Asserts that `predicate` remains truthy continuously for the entire `duration`,
 * checking every `interval` ms. Fails immediately if the condition is ever false,
 * or if it never becomes true within `timeout`.
 *
 * @throws {Error} if the condition is false at any point during the stable window.
 */
export async function waitForStable(
    predicate: () => boolean | Promise<boolean>,
    {
        duration = 5000,
        interval = 100,
        timeout = 10000,
        message = "waitForStable: condition was not stable for the required duration",
        signal
    }: {
        duration?: number;
        interval?: number;
        timeout?: number;
        message?: string;
        signal?: AbortSignal;
    } = {}
): Promise<void> {
    const deadline = Date.now() + timeout;

    // First, wait until the condition becomes true
    for (;;) {
        if (signal?.aborted) throw new Error('Aborted');
        if (await predicate()) break;
        if (Date.now() >= deadline) throw new Error(message);
        await sleep(interval, signal);
    }

    // Then, verify it stays true for the entire `duration`
    const stableDeadline = Date.now() + duration;
    for (;;) {
        if (signal?.aborted) throw new Error('Aborted');
        if (!(await predicate())) {
            throw new Error(message);
        }
        if (Date.now() >= stableDeadline) break;
        await sleep(Math.min(interval, Math.max(0, stableDeadline - Date.now())), signal);
    }
}