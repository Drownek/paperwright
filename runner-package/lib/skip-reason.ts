import type { Environment } from './environment.js';

/** Capability keys from a `requires` list that `env` does not actually satisfy. A value of
 *  `false`, `'none'`, or an absent key all count as unmet.
 *
 *  `'key:value'` demands one specific value instead — `'consoleOutput:full'` for a test that
 *  reads the server log, which a console answering only its own commands cannot provide even
 *  though it satisfies plain `'console'`. */
export function missingCapabilities(env: Environment, required: string[]): string[] {
    const capabilities = env.capabilities as unknown as Record<string, unknown>;
    return required.filter(key => {
        const separator = key.indexOf(':');
        if (separator !== -1) {
            return String(capabilities[key.slice(0, separator)]) !== key.slice(separator + 1);
        }
        const value = capabilities[key];
        return value === false || value === 'none' || value === undefined;
    });
}

/** Shared by `runFile`'s `skipReasonFor` (for a normal `TestCase`) and `reuseTest` execution
 *  (for a `ReuseTestCase`) — both check the same two `TestOptions` fields, `environments` and
 *  `requires`, against the same running environment. Name filters (`tests.names`/`exclude`) stay
 *  local to `runFile`: they're a run-level concern, not part of what a test itself declares. */
export function skipReasonForOptions(
    env: Environment,
    environmentName: string,
    requires: string[],
    environments: string[] | null,
): string | null {
    if (environments && !environments.includes(environmentName)) {
        return `requires environment in [${environments.join(', ')}], running "${environmentName}"`;
    }
    const missing = missingCapabilities(env, requires);
    if (missing.length > 0) {
        return `requires capability [${missing.join(', ')}], unavailable on "${environmentName}"`;
    }
    return null;
}
