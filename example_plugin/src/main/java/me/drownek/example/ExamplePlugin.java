package me.drownek.example;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

public final class ExamplePlugin extends JavaPlugin implements CommandExecutor, Listener {

    private final Map<String, Integer> balances = new HashMap<>();
    private final Map<UUID, Long> lastKitUse = new HashMap<>();
    private final Set<String> arenaPlayers = new HashSet<>();
    private int arenaJoinCount = 0;

    @Override
    public void onEnable() {
        this.getCommand("example").setExecutor(this);
        this.getCommand("warps").setExecutor(this);
        this.getCommand("admin").setExecutor(this);
        this.getCommand("balance").setExecutor(this);
        this.getCommand("pay").setExecutor(this);
        this.getCommand("eco").setExecutor(this);
        this.getCommand("shop").setExecutor(this);
        this.getCommand("warp").setExecutor(this);
        this.getCommand("kit").setExecutor(this);
        this.getCommand("arena").setExecutor(this);

        getServer().getPluginManager().registerEvents(this, this);

        Bukkit.getScheduler().runTaskTimer(this, () -> {
            Bukkit.broadcastMessage("Server announcement");
        }, 0L, 40L);
    }
    
    @EventHandler
    public void onCommandPreprocess(PlayerCommandPreprocessEvent event) {
        String msg = event.getMessage().toLowerCase();
        if (msg.equals("/help")) {
            event.getPlayer().sendMessage("Help: Index");
            event.setCancelled(true);
        } else if (msg.equals("/nonexistent")) {
            event.getPlayer().sendMessage("Unknown command");
            event.setCancelled(true);
        }
    }

    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        if (!balances.containsKey(player.getName())) {
            balances.put(player.getName(), 1000);
        }
        Bukkit.getScheduler().runTaskLater(this, () -> {
            player.sendMessage("Welcome");
            player.getInventory().addItem(new ItemStack(Material.WOODEN_SWORD));
        }, 10L);
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String cmd = command.getName().toLowerCase();
        
        if (cmd.equals("example")) {
            if (!sender.hasPermission("example.gui-settings")) {
                sender.sendMessage("You don't have permission to execute this command! (example) (MISSING_PERMISSIONS)");
                return true;
            }
        }
        
        if (cmd.equals("admin")) {
            if (args.length > 0 && args[0].equalsIgnoreCase("reload")) {
                if (sender.isOp() || sender.hasPermission("admin.reload")) {
                    sender.sendMessage("Reloaded");
                } else {
                    sender.sendMessage("no permission");
                }
                return true;
            }
        }
        
        if (cmd.equals("balance")) {
            int bal = balances.getOrDefault(sender.getName(), 1000);
            sender.sendMessage("$" + bal);
            return true;
        }
        
        if (cmd.equals("eco")) {
            if (args.length >= 3 && args[0].equalsIgnoreCase("give")) {
                String target = args[1];
                int amount = Integer.parseInt(args[2]);
                balances.put(target, balances.getOrDefault(target, 1000) + amount);
            } else if (args.length >= 3 && args[0].equalsIgnoreCase("set")) {
                // What a stand needs to put an account back where it started: give only ever
                // adds, so a balance spent by one test would stay spent for the next one.
                String target = args[1];
                balances.put(target, Integer.parseInt(args[2]));
                sender.sendMessage("Set balance of " + target + " to $" + args[2]);
            }
            return true;
        }
        
        if (cmd.equals("pay")) {
            if (args.length >= 2) {
                String target = args[0];
                int amount = Integer.parseInt(args[1]);
                int current = balances.getOrDefault(sender.getName(), 1000);
                if (current >= amount) {
                    balances.put(sender.getName(), current - amount);
                    balances.put(target, balances.getOrDefault(target, 1000) + amount);
                    sender.sendMessage("Sent $" + amount);
                } else {
                    sender.sendMessage("insufficient");
                }
            }
            return true;
        }
        
        if (cmd.equals("shop")) {
            if (sender instanceof Player p) {
                Inventory gui = Bukkit.createInventory(null, 9, "Shop");
                ItemStack diamond = new ItemStack(Material.DIAMOND);
                ItemMeta meta = diamond.getItemMeta();
                meta.setDisplayName("Diamond");
                diamond.setItemMeta(meta);
                gui.setItem(4, diamond);
                p.openInventory(gui);
            }
            return true;
        }
        
        if (cmd.equals("warp")) {
            if (args.length > 0) {
                if (args[0].equalsIgnoreCase("spawn")) {
                    if (sender instanceof Player p) {
                        p.teleport(new Location(p.getWorld(), 0, p.getLocation().getY(), 0));
                        p.sendMessage("Teleported to spawn");
                    }
                } else {
                    sender.sendMessage("Warp not found");
                }
            }
            return true;
        }
        
        if (cmd.equals("warps")) {
            if (sender instanceof Player player) {
                openWarps(player, 1);
            }
            return true;
        }
        
        if (cmd.equals("kit")) {
            if (args.length > 0) {
                if (args[0].equalsIgnoreCase("starter")) {
                    if (sender instanceof Player p) {
                        long lastUse = lastKitUse.getOrDefault(p.getUniqueId(), 0L);
                        if (System.currentTimeMillis() - lastUse < 5000) {
                            p.sendMessage("cooldown");
                        } else {
                            lastKitUse.put(p.getUniqueId(), System.currentTimeMillis());
                            p.sendMessage("Received starter kit");
                            p.getInventory().addItem(new ItemStack(Material.DIAMOND_SWORD));
                            p.getInventory().addItem(new ItemStack(Material.BREAD));
                        }
                    }
                } else if (args[0].equalsIgnoreCase("reset") && args.length >= 2) {
                    // Admin-only, and only meaningful from a console: it exists so a stand can
                    // hand the next test an account whose kit is claimable again.
                    if (!sender.isOp()) {
                        sender.sendMessage("no permission");
                        return true;
                    }
                    Player target = Bukkit.getPlayerExact(args[1]);
                    if (target == null) {
                        sender.sendMessage("Player not found: " + args[1]);
                    } else {
                        lastKitUse.remove(target.getUniqueId());
                        sender.sendMessage("Kit cooldown reset for " + target.getName());
                    }
                } else if (args[0].equalsIgnoreCase("vip")) {
                    if (!sender.isOp() && !sender.hasPermission("kit.vip")) {
                        sender.sendMessage("no permission");
                    } else {
                        sender.sendMessage("Received VIP kit");
                    }
                }
            }
            return true;
        }
        
        if (cmd.equals("arena")) {
            if (args.length > 0) {
                if (args[0].equalsIgnoreCase("join")) {
                    arenaJoinCount++;
                    if (arenaJoinCount == 1) {
                        sender.sendMessage("Joined arena");
                    } else {
                        sender.sendMessage("Arena is full");
                    }
                } else if (args[0].equalsIgnoreCase("leave")) {
                    sender.sendMessage("Left arena");
                } else if (args[0].equalsIgnoreCase("addplayer") && args.length > 1) {
                    arenaPlayers.add(args[1]);
                }
            }
            return true;
        }
        
        if (cmd.equals("example")) {
            if (args.length > 0 && args[0].equalsIgnoreCase("gui-settings")) {
                if (sender instanceof Player player) {
                    openGuiSettings(player);
                } else {
                    sender.sendMessage("This command can only be executed by a player.");
                }
                return true;
            }
        }
        
        return false;
    }

    private void openWarps(Player player, int page) {
        Inventory gui = Bukkit.createInventory(null, 9, "Warps");

        if (page == 1) {
            ItemStack spawn = new ItemStack(Material.COMPASS);
            ItemMeta spawnMeta = spawn.getItemMeta();
            spawnMeta.setDisplayName("Spawn");
            spawn.setItemMeta(spawnMeta);
            gui.setItem(0, spawn);

            ItemStack arrow = new ItemStack(Material.ARROW);
            ItemMeta arrowMeta = arrow.getItemMeta();
            arrowMeta.setDisplayName("arrow");
            arrow.setItemMeta(arrowMeta);
            gui.setItem(8, arrow);
        } else if (page == 2) {
            ItemStack arena = new ItemStack(Material.DIAMOND_SWORD);
            ItemMeta arenaMeta = arena.getItemMeta();
            arenaMeta.setDisplayName("Arena");
            arena.setItemMeta(arenaMeta);
            gui.setItem(0, arena);
        }

        player.openInventory(gui);
    }

    private void openGuiSettings(Player player) {
        Inventory gui = Bukkit.createInventory(null, 9, "guiSettings");

        ItemStack guiItem = new ItemStack(Material.DIAMOND);
        ItemMeta meta = guiItem.getItemMeta();
        if (meta != null) {
            meta.setDisplayName("guiItemInfo");
            guiItem.setItemMeta(meta);
        }
        gui.setItem(4, guiItem);

        player.openInventory(gui);
    }

    @EventHandler
    public void onInventoryClick(InventoryClickEvent event) {
        if (!(event.getWhoClicked() instanceof Player player)) {
            return;
        }

        String title = event.getView().getTitle();
        if (title.equals("Warps")) {
            event.setCancelled(true);
            ItemStack clickedItem = event.getCurrentItem();
            if (clickedItem == null) return;
            ItemMeta meta = clickedItem.getItemMeta();
            if (meta != null && meta.hasDisplayName()) {
                if (meta.getDisplayName().equals("arrow")) {
                    openWarps(player, 2);
                } else if (meta.getDisplayName().equals("Spawn")) {
                    player.teleport(new Location(player.getWorld(), 0, player.getLocation().getY(), 0));
                    player.sendMessage("Teleported");
                    player.closeInventory();
                }
            }
            return;
        }
        
        if (title.equals("Shop")) {
            event.setCancelled(true);
            ItemStack clicked = event.getCurrentItem();
            if (clicked != null && clicked.getType() == Material.DIAMOND) {
                if (player.getInventory().containsAtLeast(new ItemStack(Material.EMERALD), 1)) {
                    player.getInventory().removeItem(new ItemStack(Material.EMERALD, 1));
                    player.getInventory().addItem(new ItemStack(Material.DIAMOND));
                    player.sendMessage("Purchased");
                } else {
                    player.sendMessage("Not enough money");
                }
            }
            return;
        }

        if (!title.equals("guiSettings")) {
            return;
        }

        event.setCancelled(true);

        ItemStack clickedItem = event.getCurrentItem();
        if (clickedItem == null || clickedItem.getType() == Material.AIR) {
            return;
        }

        ItemMeta meta = clickedItem.getItemMeta();
        if (meta == null || !meta.hasDisplayName()) {
            return;
        }

        String displayName = meta.getDisplayName();
        if (displayName.contains("guiItemInfo")) {
            player.sendMessage("You clicked on item");
        }
    }
}
