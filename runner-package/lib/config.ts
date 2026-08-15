import { readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';

/** Config layouts this runner understands. */
export const SUPPORTED_CONFIG_VERSION = 1;

/** Default file consulted when no --config flag is given. */
export const DEFAULT_CONFIG_FILENAME = 'plugwright.config.json';

/** A secret is transported as a pointer; the value is read here, at run time. */
export type SecretRef =
    | { from: 'env'; name: string }
    | { from: 'file'; path: string }
    | { from: 'systemProperty'; name: string };

export interface RuntimeRef {
    /** npm package exporting the environment factory. */
    package: string;
    /** Named export holding the factory; the default export when omitted. */
    export?: string;
}

export interface EnvironmentConfig {
    /** Environment name, used in logs and report file names. */
    name: string;
    /** Mode id: `local`, `external`, or one contributed by a third-party module. */
    mode: string;
    /** Where to load a non-built-in environment implementation from. */
    runtime?: RuntimeRef | null;
    /** Mode-specific settings; interpreted by the environment implementation. */
    config: Record<string, unknown>;
}

export interface TestsConfig {
    /** Directory scanned for compiled spec files. Defaults to the working directory. */
    dir?: string | null;
    /** Only run spec files matching these substrings. */
    include?: string[] | null;
    /** Skip spec files matching these substrings. */
    exclude?: string[] | null;
    /** Only run tests whose name contains one of these substrings. */
    names?: string[] | null;
    /** Per-test timeout; falls back to TEST_TIMEOUT and then to 30s. */
    timeoutMs?: number | null;
}

export interface ReportsConfig {
    /** Path to write the machine-readable JSON report to. Omitted means "don't write one". */
    json?: string | null;
    /** Path to write the JUnit XML report to. Omitted means "don't write one". */
    junit?: string | null;
}

export interface PluginConfig {
    /** npm package name, or a resolvable path to a local plugin module. The default export
     *  must implement `PlugwrightPlugin`. */
    specifier: string;
    options?: Record<string, unknown>;
    /** Set false to load the plugin's hooks/matchers without pulling in its `tests`. */
    inheritTests?: boolean;
}

export interface RunnerConfig {
    version: number;
    environment: EnvironmentConfig;
    tests: TestsConfig;
    reports?: ReportsConfig | null;
    plugins?: PluginConfig[] | null;
    /** Crash-recovery journal path for `Session.journal`. Omitted disables on-disk
     *  persistence — journal entries only survive within the process. */
    journal?: string | null;
}

/** Settings of the built-in `local` mode, which spawns its own Paper server. */
export interface LocalEnvironmentConfig {
    serverJar: string;
    serverDir: string;
    javaPath: string;
    jvmArgs: string[];
    minecraftVersion?: string | null;
    host?: string | null;
    port?: number | null;
}

/**
 * Reads `--config <path>` / `--config=<path>` from the given arguments.
 */
function readConfigFlag(argv: string[]): string | null {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--config') {
            const value = argv[i + 1];
            if (!value || value.startsWith('-')) {
                throw new Error('--config requires a path to a configuration file');
            }
            return value;
        }
        if (arg.startsWith('--config=')) {
            return arg.slice('--config='.length);
        }
    }
    return null;
}

function readConfigFile(path: string): RunnerConfig {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(`Cannot read plugwright config at ${path}: ${(error as Error).message}`);
    }

    let parsed: RunnerConfig;
    try {
        parsed = JSON.parse(raw) as RunnerConfig;
    } catch (error) {
        throw new Error(`Invalid JSON in plugwright config at ${path}: ${(error as Error).message}`);
    }

    if (typeof parsed.version !== 'number') {
        throw new Error(`Plugwright config at ${path} has no "version" field`);
    }
    if (parsed.version > SUPPORTED_CONFIG_VERSION) {
        throw new Error(
            `Plugwright config at ${path} is version ${parsed.version}, this runner supports up to ` +
            `${SUPPORTED_CONFIG_VERSION}. Update @drownek/plugwright in your test project.`
        );
    }
    if (!parsed.environment || typeof parsed.environment.mode !== 'string') {
        throw new Error(`Plugwright config at ${path} has no "environment.mode"`);
    }

    parsed.tests = parsed.tests ?? {};
    parsed.reports = parsed.reports ?? {};
    parsed.plugins = parsed.plugins ?? [];
    return parsed;
}

function splitFilter(value: string | undefined): string[] | null {
    if (!value) return null;
    const parts = value.split(',').map(part => part.trim()).filter(part => part !== '');
    return parts.length > 0 ? parts : null;
}

/**
 * Pre-3.0 transport: five flat environment variables set by the Gradle plugin.
 * Kept so an older plugin keeps working with a newer runner.
 */
function configFromEnvironment(): RunnerConfig {
    const { SERVER_JAR, SERVER_DIR, JAVA_PATH, JVM_ARGS, MC_VERSION } = process.env;

    if (!SERVER_JAR || !SERVER_DIR || !JAVA_PATH) {
        throw new Error(
            'No configuration found. Pass --config <file>, or set SERVER_JAR, SERVER_DIR and JAVA_PATH.'
        );
    }

    return {
        version: SUPPORTED_CONFIG_VERSION,
        environment: {
            name: 'local',
            mode: 'local',
            config: {
                serverJar: SERVER_JAR,
                serverDir: SERVER_DIR,
                javaPath: JAVA_PATH,
                jvmArgs: (JVM_ARGS ?? '').split(' ').filter(arg => arg.trim() !== ''),
                minecraftVersion: MC_VERSION ?? null,
                host: 'localhost',
                port: 25565,
            },
        },
        tests: {
            dir: null,
            include: splitFilter(process.env.TEST_FILES),
            names: splitFilter(process.env.TEST_NAMES),
            exclude: null,
            timeoutMs: null,
        },
    };
}

/**
 * Resolves the configuration for this run.
 *
 * Order: `--config <file>`, then `plugwright.config.json` in the working directory,
 * then the legacy environment variables.
 */
export function loadRunnerConfig(argv: string[] = process.argv.slice(2)): RunnerConfig {
    const flagPath = readConfigFlag(argv);
    if (flagPath) {
        return readConfigFile(isAbsolute(flagPath) ? flagPath : resolve(process.cwd(), flagPath));
    }

    const defaultPath = resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
    try {
        readFileSync(defaultPath);
        return readConfigFile(defaultPath);
    } catch {
        return configFromEnvironment();
    }
}

/** True when [value] is a secret pointer rather than a plain value. */
export function isSecretRef(value: unknown): value is SecretRef {
    return typeof value === 'object' && value !== null && typeof (value as SecretRef).from === 'string';
}

/**
 * Reads the value a [SecretRef] points at. Config files carry references, so a password
 * never ends up in the Gradle configuration cache or in a build artifact.
 */
export function resolveSecret(ref: SecretRef): string {
    switch (ref.from) {
        case 'env': {
            const value = process.env[ref.name];
            if (value === undefined) {
                throw new Error(`Secret unavailable: environment variable ${ref.name} is not set`);
            }
            return value;
        }
        case 'file': {
            try {
                return readFileSync(ref.path, 'utf8').split(/\r?\n/)[0];
            } catch (error) {
                throw new Error(`Secret unavailable: cannot read ${ref.path}: ${(error as Error).message}`);
            }
        }
        case 'systemProperty':
            throw new Error(
                `Secret unavailable: "${ref.name}" is a JVM system property, which the runner cannot read. ` +
                'Use an environment variable or a file instead.'
            );
        default:
            throw new Error(`Unknown secret source: ${JSON.stringify(ref)}`);
    }
}
