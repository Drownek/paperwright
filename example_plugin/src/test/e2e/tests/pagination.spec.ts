import { test, expect } from '@drownek/plugwright';

test('navigate through paginated GUI', async ({ player }) => {
    await player.makeOp();
    player.chat('/warps');
    const gui = await player.gui({ title: 'Warps' });
    
    // verify page 1
    const spawnItem = gui.locator(i => i.getDisplayName().includes('Spawn'));
    await expect.poll(() => spawnItem.displayName()).toContain('Spawn');
    
    // click arrow
    const nextButton = gui.locator(i => i.name === 'arrow');
    await nextButton.click();
    
    // verify page 2 without reopening the GUI
    const arenaItem = gui.locator(i => i.getDisplayName().includes('Arena'));
    
    // This expects the item to eventually appear on the same GUI instance
    await expect.poll(() => arenaItem.displayName()).toContain('Arena');
});
