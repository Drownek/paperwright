import type { Bot } from 'mineflayer';

interface RawItem {
    name: string;
    displayName: string;
    slot: number;
    count: number;
    nbt?: {
        value?: {
            display?: {
                value?: {
                    Name?: { value: string };
                    Lore?: { value: { value: string[] } };
                }
            }
        }
    };
}

export interface Window {
    title: string;
    type: string | number;
    slots: (RawItem | null)[];
}

/**
 * A locator for GUI items.
 * Does NOT resolve the item immediately - it's a query that will be re-evaluated each time it's used.
 */
export class GuiItemLocator {
    private readonly gui: LiveGuiHandle;
    private readonly predicate: (item: ItemWrapper) => boolean;

    constructor(gui: LiveGuiHandle, predicate: (item: ItemWrapper) => boolean) {
        this.gui = gui;
        this.predicate = predicate;
    }

    /**
     * Gets the lore text of the located item.
     * Re-queries the GUI each time it's called.
     */
    loreText(): string {
        const item = this._tryFind();
        if (!item) return '';
        return item.getLore().join(' ');
    }

    /**
     * Gets the display name of the located item.
     * Re-queries the GUI each time it's called.
     */
    displayName(): string {
        const item = this._tryFind();
        if (!item) return '';
        return item.getDisplayName();
    }

    /**
     * Clicks the located item.
     * Retries until the item exists or times out.
     */
    async click(options: { timeout?: number } = {}): Promise<void> {
        const { timeout = 5000 } = options;
        const startTime = Date.now();

        for (;;) {
            const currentGui = this.gui._getCurrentGuiSnapshot();
            if (currentGui) {
                const item = currentGui._findItemInternal(this.predicate);
                if (item) {
                    await currentGui._clickItemInternal(this.predicate);
                    return;
                }
            }
            if (Date.now() - startTime >= timeout) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        throw new Error(
            `[GuiItemLocator] Timeout waiting for item to exist (${timeout}ms)\n` +
            `Gui items snapshot (may differ from what was checked during polling):\n` +
            `${this._formatItemTable()}\n`
        );
    }

    _formatItemTable(): string {
        const items = this.gui._getCurrentGuiSnapshot()?.items ?? [];
        const rows = items.map(item => ({
            slot: item.slot,
            name: item.name,
            displayName: item.getDisplayName(),
            lore: item.getLore().join(' | ')
        }));

        if (rows.length === 0) {
            return '(no items)';
        }

        const headers = ['Slot', 'Name', 'DisplayName', 'Lore'];
        const widths = [
            Math.max(4, ...rows.map(r => String(r.slot).length)),
            Math.max(4, ...rows.map(r => r.name.length)),
            Math.max(11, ...rows.map(r => r.displayName.length)),
            Math.max(4, ...rows.map(r => r.lore.length)),
        ];

        const header = headers.map((h, i) => h.padEnd(widths[i])).join(' | ');
        const separator = widths.map(w => '-'.repeat(w)).join('-+-');
        const body = rows.map(r =>
            `${String(r.slot).padEnd(widths[0])} | ${r.name.padEnd(widths[1])} | ${r.displayName.padEnd(widths[2])} | ${r.lore}`
        ).join('\n');

        return [header, separator, body].join('\n');
    }

    /**
     * Internal method used by matchers to get the predicate.
     */
    _getPredicate(): (item: ItemWrapper) => boolean {
        return this.predicate;
    }

    /**
     * Internal method used by matchers to get the GUI handle.
     */
    _getGuiHandle(): LiveGuiHandle {
        return this.gui;
    }

    /**
     * Attempts to find the item in the current GUI state.
     * Returns undefined if not found.
     */
    private _tryFind(): ItemWrapper | undefined {
        const currentGui = this.gui._getCurrentGuiSnapshot();
        if (!currentGui) return undefined;
        return currentGui._findItemInternal(this.predicate);
    }
}

/**
 * A live handle to the player's GUI.
 * This is NOT a snapshot - it always reflects the player's CURRENT open GUI.
 */
export class LiveGuiHandle {
    private readonly bot: Bot;
    private readonly titleMatcher: (title: string) => boolean;

    constructor(bot: Bot, titleMatcher: (title: string) => boolean) {
        this.bot = bot;
        this.titleMatcher = titleMatcher;
    }

    /**
     * Gets the current GUI title, or undefined if no GUI is open or doesn't match.
     */
    get title(): string | undefined {
        const gui = this._getCurrentGuiSnapshot();
        return gui?.title;
    }

    /**
     * Creates a locator for items matching the predicate.
     * The locator does NOT resolve immediately - it's a query that will be re-evaluated each time it's used.
     */
    locator(predicate: (item: ItemWrapper) => boolean): GuiItemLocator {
        return new GuiItemLocator(this, predicate);
    }

    /**
     * Internal method to get a snapshot of the current GUI state.
     * Returns undefined if no GUI is open or if it doesn't match the title matcher.
     */
    _getCurrentGuiSnapshot(): GuiWrapper | undefined {
        if (!this.bot.currentWindow) return undefined;
        const gui = new GuiWrapper(this.bot, this.bot.currentWindow as Window);
        return this.titleMatcher(gui.title) ? gui : undefined;
    }

    /**
     * Internal method to get the bot instance.
     */
    _getBot(): Bot {
        return this.bot;
    }
}

export class ItemWrapper {
    raw: RawItem;
    name: string;
    slot: number;
    count: number;

    constructor(rawItem: RawItem) {
        this.raw = rawItem;
        this.name = rawItem.name;
        this.slot = rawItem.slot;
        this.count = rawItem.count;
    }

    static parseChat(raw: any): string {
        if (raw == null) return '';
        if (typeof raw === 'string') {
            try {
                raw = JSON.parse(raw);
            } catch (e) {
                return raw;
            }
        }

        if (typeof raw === 'object' && raw !== null) {
            const unwrapNbt = (tag: any): any => {
                if (tag === null || typeof tag !== 'object') return tag;
                if (typeof tag.type === 'string' && 'value' in tag) {
                    if (tag.type === 'compound') {
                        const unwrapped: any = {};
                        for (const key in tag.value) {
                            unwrapped[key] = unwrapNbt(tag.value[key]);
                        }
                        return unwrapped;
                    } else if (tag.type === 'list') {
                        const listData = tag.value;
                        if (listData && listData.type && Array.isArray(listData.value)) {
                            return listData.value.map((v: any) => unwrapNbt({ type: listData.type, value: v }));
                        } else if (Array.isArray(listData)) {
                            return listData.map(unwrapNbt);
                        }
                        return [];
                    } else {
                        return tag.value;
                    }
                }
                if (Array.isArray(tag)) {
                    return tag.map(unwrapNbt);
                }
                const unwrapped: any = {};
                for (const key in tag) {
                    unwrapped[key] = unwrapNbt(tag[key]);
                }
                return unwrapped;
            };

            const unwrappedRaw = unwrapNbt(raw);

            // If it unwrapped to a string, it might be a JSON string of a chat component.
            if (typeof unwrappedRaw === 'string') {
                try {
                    const parsed = JSON.parse(unwrappedRaw);
                    if (typeof parsed === 'object') {
                        return ItemWrapper.parseChat(parsed);
                    }
                } catch (e) { }
                return unwrappedRaw;
            }

            const extractText = (obj: any): string => {
                if (typeof obj === 'string') return obj;
                if (!obj || typeof obj !== 'object') return '';

                let result = obj.text || obj.translate || '';

                if (Array.isArray(obj.with)) {
                    result += obj.with.map(extractText).join(' ');
                }

                if (Array.isArray(obj.extra)) {
                    result += obj.extra.map(extractText).join('');
                }

                return result;
            };

            return extractText(unwrappedRaw);
        }

        return String(raw);
    }

    getDisplayName(): string {
        const components = (this.raw as any).components;
        if (Array.isArray(components)) {
            const customNameComp = components.find(c => c.type === 'custom_name');
            if (customNameComp && customNameComp.data) {
                return ItemWrapper.parseChat(customNameComp.data);
            }
        }

        const customName = (this.raw as any).customName;
        if (customName) {
            return ItemWrapper.parseChat(customName);
        }

        const nbtName = this.raw.nbt?.value?.display?.value?.Name?.value;

        if (nbtName) {
            return ItemWrapper.parseChat(nbtName);
        }

        return this.raw.displayName || this.name;
    }

    getLore(): string[] {
        const components = (this.raw as any).components;
        if (Array.isArray(components)) {
            const loreComp = components.find(c => c.type === 'lore');
            // lore data might be an array of lines, e.g. { type: 'lore', data: [...] }
            if (loreComp && Array.isArray(loreComp.data)) {
                return loreComp.data.map((line: any) => ItemWrapper.parseChat(line));
            }
        }

        const customLore = (this.raw as any).customLore;
        if (customLore && Array.isArray(customLore)) {
            return customLore.map((line: any) => ItemWrapper.parseChat(line));
        }

        const nbtLore = this.raw.nbt?.value?.display?.value?.Lore?.value?.value;

        if (!nbtLore || !Array.isArray(nbtLore)) return [];

        return nbtLore.map(line => ItemWrapper.parseChat(line));
    }

    hasLore(text: string): boolean {
        return this.getLore().some(line =>
            line.toLowerCase().includes(text.toLowerCase())
        );
    }
}

/**
 * @internal
 * @deprecated GuiWrapper is primarily for internal use. Use LiveGuiHandle and GuiItemLocator for new code.
 *
 * GuiWrapper represents a snapshot of a GUI at a specific point in time.
 * For live, reactive GUI interactions, use `player.gui({ title })` which returns a LiveGuiHandle.
 */
export class GuiWrapper {
    bot: Bot;
    window: Window;
    title: string;
    items: ItemWrapper[];

    constructor(bot: Bot, window: Window) {
        this.bot = bot;
        this.window = window;
        this.title = ItemWrapper.parseChat(window.title);
        this.items = window.slots
            .filter((item): item is RawItem => item != null)
            .map(item => new ItemWrapper(item));
    }

    // -----------------------------------------------------------------------
    // Internal methods — no deprecation warnings.
    // Used by GuiItemLocator and other internal code.
    // -----------------------------------------------------------------------

    /** @internal */
    _findItemInternal(predicate: (item: ItemWrapper) => boolean): ItemWrapper | undefined {
        return this.items.find(predicate);
    }

    /** @internal */
    _findAllItemsInternal(predicate: (item: ItemWrapper) => boolean): ItemWrapper[] {
        return this.items.filter(predicate);
    }

    /** @internal */
    _hasItemInternal(predicate: (item: ItemWrapper) => boolean): boolean {
        return this.items.some(predicate);
    }

    /** @internal */
    async _clickItemInternal(predicate: (item: ItemWrapper) => boolean): Promise<void> {
        const item = this._findItemInternal(predicate);
        if (!item) {
            throw new Error(`[GUI] Failed to click: Item not found matching criteria in "${this.title}"`);
        }

        const lore = item.getLore();
        console.log(`[GUI] Clicking item: ${item.getDisplayName()}`);
        console.log(`  Material: ${item.name}`);
        console.log(`  Slot: ${item.slot}`);
        if (lore.length > 0) {
            console.log(`  Lore: ${lore.join(' | ')}`);
        }

        await this.bot.clickWindow(item.slot, 0, 0);
    }

    // -----------------------------------------------------------------------
    // Public deprecated methods — warn once then delegate to internal methods.
    // -----------------------------------------------------------------------

    /**
     * @deprecated Use gui.locator() with expectations instead. This method will be removed in a future version.
     * @internal This class is primarily for internal use. Use LiveGuiHandle and GuiItemLocator instead.
     */
    hasItem(predicate: (item: ItemWrapper) => boolean): boolean {
        console.warn('[DEPRECATED] GuiWrapper.hasItem() is deprecated. Use gui.locator() instead.');
        return this._hasItemInternal(predicate);
    }

    /**
     * @deprecated Use gui.locator() to get items. This method will be removed in a future version.
     * @internal This class is primarily for internal use. Use LiveGuiHandle and GuiItemLocator instead.
     */
    findItem(predicate: (item: ItemWrapper) => boolean): ItemWrapper | undefined {
        console.warn('[DEPRECATED] GuiWrapper.findItem() is deprecated. Use gui.locator() instead.');
        return this._findItemInternal(predicate);
    }

    /**
     * @deprecated Use multiple gui.locator() calls if needed. This method will be removed in a future version.
     * @internal This class is primarily for internal use. Use LiveGuiHandle and GuiItemLocator instead.
     */
    findAllItems(predicate: (item: ItemWrapper) => boolean): ItemWrapper[] {
        console.warn('[DEPRECATED] GuiWrapper.findAllItems() is deprecated. Use gui.locator() instead.');
        return this._findAllItemsInternal(predicate);
    }

    /**
     * @deprecated Use gui.locator().click() instead. This method will be removed in a future version.
     * @internal This class is primarily for internal use. Use LiveGuiHandle and GuiItemLocator instead.
     */
    async clickItem(predicate: (item: ItemWrapper) => boolean): Promise<void> {
        console.warn('[DEPRECATED] GuiWrapper.clickItem() is deprecated. Use gui.locator().click() instead.');
        return this._clickItemInternal(predicate);
    }
}

export function createPlayerExtensions(bot: Bot) {
    return {
        async waitForGuiItem(
            itemMatcher: (item: ItemWrapper) => boolean,
            options: { timeout?: number; pollingRate?: number } = {}
        ): Promise<ItemWrapper> {
            console.warn('[DEPRECATED] player.waitForGuiItem() is deprecated. Use gui.locator() with expectations instead. See documentation for migration guide.');

            const { timeout = 5000, pollingRate = 100 } = options;
            const startTime = Date.now();

            for (;;) {
                if (bot.currentWindow) {
                    const window = bot.currentWindow as Window;
                    const items = window.slots
                        .filter((item): item is RawItem => item != null)
                        .map(item => new ItemWrapper(item));

                    const matchedItem = items.find(itemMatcher);

                    if (matchedItem) {
                        console.log(`[Player] Found GUI item: ${matchedItem.getDisplayName()} at slot ${matchedItem.slot}`);
                        return matchedItem;
                    }
                }

                if (Date.now() - startTime >= timeout) {
                    throw new Error(`[Player] Timeout waiting for GUI item (${timeout}ms)`);
                }

                await new Promise(resolve => setTimeout(resolve, pollingRate));
            }
        },

        async clickGuiItem(
            itemMatcher: (item: ItemWrapper) => boolean,
            options: { timeout?: number; pollingRate?: number } = {}
        ): Promise<void> {
            console.warn('[DEPRECATED] player.clickGuiItem() is deprecated. Use gui.locator().click() instead. See documentation for migration guide.');

            const { timeout = 5000, pollingRate = 100 } = options;
            const startTime = Date.now();

            for (;;) {
                if (bot.currentWindow) {
                    const window = bot.currentWindow as Window;
                    const items = window.slots
                        .filter((item): item is RawItem => item != null)
                        .map(item => new ItemWrapper(item));

                    const matchedItem = items.find(itemMatcher);

                    if (matchedItem) {
                        const lore = matchedItem.getLore();
                        console.log(`[Player] Clicking GUI item: ${matchedItem.getDisplayName()}`);
                        console.log(`  Material: ${matchedItem.name}`);
                        console.log(`  Slot: ${matchedItem.slot}`);
                        if (lore.length > 0) {
                            console.log(`  Lore: ${lore.join(' | ')}`);
                        }

                        await bot.clickWindow(matchedItem.slot, 0, 0);
                        return;
                    }
                }

                if (Date.now() - startTime >= timeout) {
                    throw new Error(`[Player] Timeout waiting for GUI item to click (${timeout}ms)`);
                }

                await new Promise(resolve => setTimeout(resolve, pollingRate));
            }
        },

        async waitForGui(
            guiMatcher: (gui: GuiWrapper) => boolean,
            options: { timeout?: number } = {}
        ): Promise<GuiWrapper> {
            console.warn('[DEPRECATED] player.waitForGui() is deprecated. Use player.gui({ title }) instead. See documentation for migration guide.');

            const { timeout = 5000 } = options;

            return new Promise((resolve, reject) => {
                let settled = false;

                const tryMatch = (): GuiWrapper | null => {
                    if (!bot.currentWindow) return null;
                    const gui = new GuiWrapper(bot, bot.currentWindow as Window);
                    return guiMatcher(gui) ? gui : null;
                };

                const settle = (gui: GuiWrapper) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    console.log(`[Player] GUI matched: "${gui.title}"`);
                    resolve(gui);
                };

                const attempt = () => {
                    if (settled) return;
                    const matched = tryMatch();
                    if (matched) settle(matched);
                };

                const deadline = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new Error(`[Player] Timeout waiting for GUI matching predicate (${timeout}ms)`));
                }, timeout);

                const onWindowOpen = () => {
                    setImmediate(attempt);
                };

                const cleanup = () => {
                    clearTimeout(deadline);
                    bot.removeListener('windowOpen', onWindowOpen);
                };

                bot.on('windowOpen', onWindowOpen);

                setImmediate(attempt);
            });
        },

        /**
         * Get a live handle to a GUI matching the title.
         * It waits ONLY until a GUI with matching title exists.
         * It does NOT wait for items, slots, or lore.
         *
         * The returned handle is LIVE - it always reflects the player's CURRENT open GUI.
         *
         * @param options.title - String or RegExp to match against GUI title
         * @param options.timeout - Maximum time to wait for GUI to appear (default: 5000ms)
         */
        async gui(
            options: { title: string | RegExp; timeout?: number }
        ): Promise<LiveGuiHandle> {
            const { title, timeout = 5000 } = options;

            // Create title matcher function
            const titleMatcher = typeof title === 'string'
                ? (guiTitle: string) => guiTitle.includes(title)
                : (guiTitle: string) => title.test(guiTitle);

            return new Promise((resolve, reject) => {
                let settled = false;

                const tryMatch = (): boolean => {
                    if (!bot.currentWindow) return false;
                    const gui = new GuiWrapper(bot, bot.currentWindow as Window);
                    return titleMatcher(gui.title);
                };

                const settle = () => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    const handle = new LiveGuiHandle(bot, titleMatcher);
                    console.log(`[Player] GUI matched: "${handle.title}"`);
                    resolve(handle);
                };

                const attempt = () => {
                    if (settled) return;
                    if (tryMatch()) settle();
                };

                const deadline = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(new Error(`[Player] Timeout waiting for GUI with title matching pattern (${timeout}ms)`));
                }, timeout);

                const onWindowOpen = () => {
                    setImmediate(attempt);
                };

                const cleanup = () => {
                    clearTimeout(deadline);
                    bot.removeListener('windowOpen', onWindowOpen);
                };

                bot.on('windowOpen', onWindowOpen);

                setImmediate(attempt);
            });
        }
    };
}
