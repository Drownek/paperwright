import pc from 'picocolors';
import { RunnerMatchers } from './matchers.js';
import { PLUGIN_API_VERSION } from './plugin.js';
import type { PlugwrightPlugin, PluginTestRef } from './plugin.js';
import type { Session } from './session.js';
import type { PlayerWrapper } from './player.js';
import type { Environment } from './environment.js';
import type { Account } from './account.js';
import type { TestContext } from './types.js';
import type { PluginConfig } from './config.js';

interface LoadedPlugin {
    plugin: PlugwrightPlugin;
    options: Record<string, unknown>;
    inheritTests: boolean;
}

/**
 * Owns every loaded `PlugwrightPlugin`: hooks fired around each test, matchers merged into
 * `RunnerMatchers`, fixtures merged into `TestContext`, and inherited test files. One
 * instance per session.
 */
export class PluginHost {
    private readonly plugins: LoadedPlugin[] = [];

    async load(configs: PluginConfig[]): Promise<void> {
        for (const cfg of configs) {
            let mod: any;
            try {
                mod = await import(cfg.specifier);
            } catch (error) {
                throw new Error(`Failed to load plugin "${cfg.specifier}": ${(error as Error).message}`);
            }

            const plugin = (mod.default ?? mod) as PlugwrightPlugin;
            if (!plugin || typeof plugin.name !== 'string') {
                throw new Error(`Plugin "${cfg.specifier}" has no default export implementing PlugwrightPlugin (missing "name")`);
            }
            if (plugin.apiVersion !== undefined && plugin.apiVersion > PLUGIN_API_VERSION) {
                throw new Error(
                    `Plugin "${plugin.name}" was built against plugin API v${plugin.apiVersion}, ` +
                    `this runner supports up to v${PLUGIN_API_VERSION}. Update @drownek/plugwright.`
                );
            }

            this.plugins.push({ plugin, options: cfg.options ?? {}, inheritTests: cfg.inheritTests ?? true });
            console.log(pc.dim(`[plugin] loaded "${plugin.name}" (${cfg.specifier})`));
        }
    }

    get names(): string[] {
        return this.plugins.map(p => p.plugin.name);
    }

    /** Merges declared matchers into the shared `RunnerMatchers` prototype. Must run before
     *  the first spec file is imported — `expect(x).foo()` looks the matcher up on the
     *  prototype at call time, not at registration time. */
    registerMatchers(): void {
        for (const { plugin } of this.plugins) {
            for (const [matcherName, fn] of Object.entries(plugin.matchers ?? {})) {
                (RunnerMatchers.prototype as any)[matcherName] = fn;
            }
        }
    }

    async setup(session: Session): Promise<void> {
        for (const { plugin, options } of this.plugins) {
            await plugin.setup?.({ session, env: session.env, options });
        }
    }

    async onPlayerCreate(player: PlayerWrapper, ctx: { account: Account; env: Environment }): Promise<void> {
        for (const { plugin } of this.plugins) {
            await plugin.onPlayerCreate?.(player, ctx);
        }
    }

    async beforeEach(ctx: TestContext): Promise<void> {
        for (const { plugin } of this.plugins) {
            await plugin.beforeEach?.(ctx);
        }
    }

    /** Runs in reverse plugin order, mirroring the LIFO shape of afterEach hooks elsewhere.
     *  Errors are logged, not thrown — a plugin's own afterEach hiccup shouldn't flip an
     *  otherwise-passing test's result. */
    async afterEach(ctx: TestContext): Promise<void> {
        for (const { plugin } of [...this.plugins].reverse()) {
            try {
                await plugin.afterEach?.(ctx);
            } catch (error) {
                console.error(pc.red(`[plugin ${plugin.name}] afterEach error: ${(error as Error).message}`));
            }
        }
    }

    extendContext(ctx: TestContext): void {
        for (const { plugin } of this.plugins) {
            const extra = plugin.extendContext?.(ctx);
            if (extra) Object.assign(ctx, extra);
        }
    }

    /** Inherited test files for the given mode, across every plugin with `inheritTests`
     *  enabled. `findSpecFiles` never sees these — it skips `node_modules` — so this is the
     *  only way a plugin's own tests run. */
    testFiles(mode: PluginTestRef['mode']): { file: string; pluginName: string }[] {
        return this.plugins
            .filter(p => p.inheritTests)
            .flatMap(({ plugin }) =>
                (plugin.tests ?? [])
                    .filter(t => t.mode === mode)
                    .map(t => ({ file: t.file, pluginName: plugin.name }))
            );
    }

    async runCleanup(session: Session, scope: 'session' | 'manual'): Promise<void> {
        for (const { plugin } of [...this.plugins].reverse()) {
            try {
                await plugin.cleanup?.({ session, scope });
            } catch (error) {
                console.error(pc.red(`[plugin ${plugin.name}] cleanup error: ${(error as Error).message}`));
            }
        }
    }

    async teardown(): Promise<void> {
        for (const { plugin } of [...this.plugins].reverse()) {
            try {
                await plugin.teardown?.();
            } catch (error) {
                console.error(pc.red(`[plugin ${plugin.name}] teardown error: ${(error as Error).message}`));
            }
        }
    }
}
