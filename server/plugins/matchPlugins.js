// server/plugins/matchPlugins.js — the loader of a trusted plugin's `entry.match`: the module that runs *inside* the
// process that runs the match and may change its state.
//
// Why in-process and not the trusted IPC child: a match module's rules are synchronous writes to the match (funds, LP,
// pending death) plus timers, uid allocation and its own RNG stream. The IPC bridge only carries frozen copies, so it
// cannot express any of that. The gate is the same one the other trusted entries use — the class, plus the owner's pin
// of this plugin's lock (`plugins/config.json` `trusted.<id> = lockHash`, server/plugins/trusted.js). A plugin without
// the pin is never imported.
//
// The module is imported from its folder (not from a data URL), so a multi-file plugin can use relative imports.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Attach `plugin.match = { activate }` (or `{ error }`) to every trusted plugin that declares `entry.match`.
 * Idempotent: a rescan re-runs it, and a module whose lock hash did not change is not imported again.
 * @param {any} registry the plugin registry (server/plugins/registry.js)
 * @param {{ log?: any }} [opts]
 */
export async function preloadMatchModules(registry, { log } = {}) {
  let list = [];
  try { list = registry.plugins('trusted'); } catch { return; }
  for (const p of list) {
    const rel = p && p.manifest && p.manifest.entry && p.manifest.entry.match;
    if (!rel) { if (p) p.match = null; continue; }
    if (p.status !== 'loaded') {
      p.match = { error: (p.disabled && p.disabled.code) || 'PLUGIN_SCRIPTS_DISABLED' };
      continue;
    }
    const dir = p.script && p.script.dir;
    if (!dir) { p.match = { error: 'PLUGIN_SCRIPT_CHECK' }; continue; }
    const stamp = (p.script && (p.script.lockHash || p.hash)) || '';
    if (p.match && p.match.stamp === stamp && (p.match.activate || p.match.error)) continue;
    try {
      const url = `${pathToFileURL(path.join(dir, rel)).href}?lock=${encodeURIComponent(stamp)}`;
      const mod = await import(url);
      const activate = mod.activate || mod.default;
      if (typeof activate !== 'function') throw new Error('the match entry exports no activate(match)');
      p.match = { activate, stamp };
    } catch (e) {
      p.match = { error: String((e && e.message) || e).slice(0, 300), stamp };
      log?.warn?.(`[plugins] ${p.id}: match entry not loaded — ${e?.message || e}`);
    }
  }
}

/**
 * The factories a match of this content set starts with. A vanilla room has no plugins, so `[]` — and every hook in
 * server/match/plugins.js is then a no-op.
 * @param {any[]|null|undefined} plugins the room's content-set plugin records
 */
export function matchFactoriesOf(plugins) {
  return (plugins || [])
    .filter((p) => p && p.match && typeof p.match.activate === 'function')
    .map((p) => ({ id: p.id, activate: p.match.activate }));
}
