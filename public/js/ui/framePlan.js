// public/js/ui/framePlan.js — which slot a panel gets and how many frames it needs, as data.
//
// A plugin declares slots; the page renders hosts for some of them. A **repeatable** slot (the content's
// `screen.game.shopCard`) renders one host per item, and the panel mounts into every one — one frame each, keyed by the
// host's `data-ui-host-key`. Every other slot takes a single holder. Keeping this decision pure lets it be tested
// without a browser (test/plugins/frame-plan.test.js); public/js/ui/pluginFrame.js only builds what the plan says.
import { UI_SLOT_IDS } from '../../../shared/plugins/manifest.js';

/**
 * @param {{ declared: string[], hosts?: Record<string, string[]>,
 *   isRepeatable?: (slot: string) => boolean, holder?: (slot: string) => string | null }} ctx
 *   `hosts`: slot → the `data-ui-host-key`s of its host elements, in document order (absent = no host on this page)
 * @returns {{ slot: string, repeatable: boolean, keys: string[] } | null}
 */
export function planMount({ declared = [], hosts = {}, isRepeatable = () => false, holder = () => null }) {
  const allowed = declared.filter((s) => typeof s === 'string' && UI_SLOT_IDS.includes(s));
  // a repeatable slot with at least one host: one frame per host, and any number of plugins may have it
  const rep = allowed.find((s) => isRepeatable(s) && (hosts[s] || []).length > 0);
  if (rep) return { slot: rep, repeatable: true, keys: [...(hosts[rep] || [])] };
  // the first declared slot whose host exists and that nobody holds
  const withHost = allowed.find((s) => !isRepeatable(s) && (hosts[s] || []).length > 0 && !holder(s));
  if (withHost) return { slot: withHost, repeatable: false, keys: [] };
  // the first declared slot nobody holds: the frame mounts parked until its host appears
  const free = allowed.find((s) => !isRepeatable(s) && !holder(s));
  return free ? { slot: free, repeatable: false, keys: [] } : null;
}

/** The frame keys the plan needs: `<pluginId>#<hostKey>` per host, or the plugin id alone. */
export function frameKeys(pluginId, plan) {
  if (!plan) return [pluginId];
  if (!plan.repeatable) return [pluginId];
  return plan.keys.length ? plan.keys.map((k) => `${pluginId}#${k}`) : [pluginId];
}
