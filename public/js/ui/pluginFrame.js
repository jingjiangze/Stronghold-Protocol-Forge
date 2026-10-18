// ui/pluginFrame.js — the host side of an interface plugin (DESIGN §32.8, shared/plugins/ui.js).
// Imported for its effect from screens/game.js (the match already loads the battle runner). It does not import the
// art compositor, the plugin panel or the asset store. With no interface plugin switched on, and on a server that
// reports none, it does not ask for the catalogue.
//
// Each switched-on plugin is one <iframe sandbox="allow-scripts"> (no allow-same-origin: an opaque origin, so it has
// no site storage and no credentials). The same `sandbox allow-scripts` is on the /p/ response (UI_FRAME_CSP), because
// the attribute is not there when the URL is opened at the top level. The parent posts with targetOrigin '*' because
// that origin is the string "null" — 'null' does not tell the entry document from a later opaque one.
// Loads: 1 is the entry (the iframe points straight at it), 2+ destroys the frame and stops the feed. A message is applied on
// the next turn so a load event already queued runs first. A message is accepted only from that iframe's window,
// and only when event.origin is "null".
// The iframe is parked on #sp-ui-park until its slot element exists, then moved into [data-ui-slot]. The slot div
// opts out of Preact's children (dangerouslySetInnerHTML) so a re-render does not drop the frame; if a screen
// unmounts the slot, the frame is moved back to the park in the same mutation.
//
// [ASSUMED] the first declared slot that has an element is granted when the frame is created, otherwise the first
// free declared slot, so the frame has a home before its own `slot` message. The protocol table stays one plugin
// per slot. When several plugins prefer the same slot, the first by name is shown and the player switches the
// others with tabs in the slot. Nothing here calls net.send. A match intent is rejected locally.

import { store } from '../store.js';
import { net } from '../net.js';
import { battleRunner } from '../battle/runner.js';
import { catalog, loadCatalog, installedCount, pluginName } from '../content.js';
import { toast } from './toasts.js';
import { getLang, t } from '../../../shared/i18n.js';
import { PROTOCOL_VERSION } from '../../../shared/constants.js';
import { uiPlugins, uiPluginEntries } from './uiPlugins.js';
import {
  UI_ERRORS, UI_LIMITS, UI_SLOTS, battlePayload, checkStorageWrite, clampHeight, clampNotice, createNoticeLimiter,
  createRateLimiter, createSlotTable, frameLoadDecision, framePageUrl, hostLimit, hostNet, hostRejected, hostResult,
  hostState, hostWelcome, isIntentType, namespacedStorageKey, netSlot, subsetRoom, validatePluginMessage,
} from '../../../shared/plugins/ui.js';
import { UI_SLOT_ALIASES } from '../../../shared/plugins/manifest.js';
import { planMount } from './framePlan.js';

const SLOT_MS = Math.round(1000 / UI_LIMITS.battleHz);
const STATE_MS = 250;
const LIMIT_MS = 2000;

/** @type {Map<string, FrameRec>} */
const frames = new Map();
/** Plugins stopped for leaving their entry page: not mounted again until this page reloads (no re-mount loop). */
const blocked = new Set();
const slots = createSlotTable();
/** slot → plugin the player chose to see. Absent: the first by name. */
const chosenSlot = new Map();
const limiter = createRateLimiter();
const noticeLimiter = createNoticeLimiter();
const rejected = [];
/** @type {{ last: object | null, rejected: string[], debugBattle: (events: unknown) => void, frames: () => string[] }} */
const api = {
  blocked: () => [...blocked],
  rejected,
  last: null,
  // the mounted frames: one key per plugin, or `<pluginId>#<hostKey>` for each instance of a repeatable slot
  frames: () => [...frames.keys()],
  debugBattle(events) {
    const msg = battlePayload({ fieldId: 'debug', gt: 0, events, snap: null });
    api.last = msg;
    for (const rec of frames.values()) post(rec, msg);
  },
};

/**
 * One mounted document. A plugin has one of these per host element: a repeatable slot (`screen.game.shopCard`) renders
 * a host in every shop card and each card gets its own frame, so `id` is the frame's key (the plugin id, or
 * `<pluginId>#<hostKey>` for an instance) while `pluginId` is always the plugin it belongs to.
 * @typedef {{ id: string, pluginId: string, hostKey: string | null, host: Element | null,
 *   iframe: HTMLIFrameElement, declared: string[], entry: any, ready: boolean,
 *   preview?: any, entries: Record<string, string>, limitAt: number, loads: number, closed: boolean,
 *   netAt?: number | null, netText?: string }} FrameRec
 */

let park = null;
let booted = false;
let stateTimer = 0;
let lastState = '';
let netTimer = 0;
let lastResultText = '';
let battleTimer = 0;
/** @type {unknown[]} */
let battleQueue = [];
let battleField = null;
let battleGt = null;
let lastSnap = null;

function parkEl() {
  if (park && park.isConnected) return park;
  park = document.createElement('div');
  park.id = 'sp-ui-park';
  park.hidden = true;
  park.setAttribute('aria-hidden', 'true');
  document.body.appendChild(park);
  return park;
}

/** @param {FrameRec} rec @param {object} msg */
/** Private feed only while the entry document is the one that finished loading. */
function feeding(rec) {
  return !rec.closed && frames.get(rec.id) === rec && rec.ready && frameLoadDecision(rec.loads) === 'entry';
}

function post(rec, msg) {
  if (rec.closed || frames.get(rec.id) !== rec) return;
  const w = rec.iframe.contentWindow;
  if (!w) return;
  try {
    w.postMessage(msg, '*');
    api.last = msg;
  } catch { /* the frame is gone */ }
}

/** Every frame of one plugin (a repeatable slot has one per host). @param {string} pluginId */
function framesOf(pluginId) {
  const out = [];
  for (const rec of frames.values()) if (rec.pluginId === pluginId) out.push(rec);
  return out;
}

/** Remove one frame. The plugin's slot is released only when its last frame goes. @param {string} id */
function destroy(id) {
  const rec = frames.get(id);
  if (!rec) return;
  rec.closed = true;
  rec.ready = false;
  frames.delete(id);
  limiter.reset(id);
  noticeLimiter.reset(id);
  rec.iframe.remove();
  if (framesOf(rec.pluginId).length) return;
  for (const [slot, held] of chosenSlot) if (held === rec.pluginId) chosenSlot.delete(slot);
  slots.release(rec.pluginId);
}

/** A frame left its entry document: destroy every frame of the plugin and keep it off for the rest of this page. */
function stopForLeaving(pluginId) {
  if (!framesOf(pluginId).length) return;
  blocked.add(pluginId);
  for (const rec of framesOf(pluginId)) destroy(rec.id);
  try { toast(t('界面插件离开了自己的页面，本页已停用它（刷新后恢复）'), 'warn'); } catch { /* the toast host may be absent */ }
}

function destroyAll() {
  for (const id of [...frames.keys()]) destroy(id);
}

/**
 * A slot that left the document took its frame with it. Move that frame back to the park.
 * A frame we just moved ourselves is still connected, so it is left where it is (moving it again would loop).
 * @param {Node} node
 * @returns {boolean}
 */
function rescue(node) {
  if (!node || node.nodeType !== 1) return false;
  const el = /** @type {Element} */ (node);
  if (el.isConnected) return false;
  const frame = el.classList && el.classList.contains('ui-slot__frame') ? el : (el.querySelector ? el.querySelector('.ui-slot__frame') : null);
  if (!frame || frame.isConnected) return false;
  // only a live frame is re-parked: a destroyed one (no record any more) stays removed instead of coming back as an
  // orphan that reloads the plugin's page. `data-rec` is the frame's own key (an instance of a repeatable slot has one).
  const el2 = /** @type {HTMLElement} */ (frame);
  const rec = frames.get(el2.dataset.rec || '') || frames.get(el2.dataset.plugin || '') || framesOf(el2.dataset.plugin || '')[0];
  if (!rec || rec.iframe !== frame || rec.closed) return false;
  moveFrame(rec, parkEl());
  return true;
}

/**
 * The host moves a frame. A browser reloads an iframe that changes parent, from its `src` — the entry — so the load
 * count and the handshake start over (the plugin answers the new `welcome` with a new `ready`). A navigation the
 * plugin starts itself still counts past the entry and destroys the frame.
 * @param {FrameRec} rec @param {Element} home
 */
function moveFrame(rec, home) {
  rec.loads = 0;
  rec.ready = false;
  rec.netAt = null;
  rec.netText = '';
  home.appendChild(rec.iframe);
}

/** @param {FrameRec} rec */
function place(rec) {
  const slot = slots.slotOf(rec.pluginId);
  const el = rec.host || (slot ? hostOf(slot, rec.hostKey) : null);
  const home = rec.preview?.host || el || parkEl();
  if (rec.iframe.parentElement !== home) moveFrame(rec, home);
}

/**
 * The element a slot mounts into: its own `[data-ui-slot="<slot>"]`, else the element of the name it aliases
 * (UI_SLOT_ALIASES: the content's `screen.game.hud` is the same place as the older `hud.right`). An instance of a
 * repeatable slot names its host's key, so each card gets its own frame.
 * @param {string | null | undefined} slot @param {string | null} [hostKey]
 * @returns {Element | null}
 */
function hostOf(slot, hostKey = null) {
  if (!slot) return null;
  if (hostKey) {
    const at = document.querySelector(`[data-ui-slot="${slot}"][data-ui-host-key="${hostKey}"]`);
    if (at) return at;
  }
  const own = document.querySelector(`[data-ui-slot="${slot}"]`);
  if (own) return own;
  const alias = UI_SLOT_ALIASES[slot];
  return alias ? document.querySelector(`[data-ui-slot="${alias}"]`) : null;
}

/** Every host element of a slot, in document order (a repeatable slot renders one per item). */
function hostsOf(slot) {
  return [...document.querySelectorAll(`[data-ui-slot="${slot}"]`)];
}

function byPluginName(a, b) {
  const an = pluginName(a.entry) || a.pluginId;
  const bn = pluginName(b.entry) || b.pluginId;
  return an.localeCompare(bn) || (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);
}

/** The first declared slot that currently has an element. */
function preferredSlot(rec) {
  const allowed = rec.declared.filter((s) => UI_SLOTS.includes(s));
  return allowed.find((s) => hostOf(s)) || null;
}

/**
 * One holder per slot. Several plugins may prefer it: the player's tab wins, otherwise the first by name.
 * The others stay mounted and parked until a tab shows them. [ASSUMED] that initial order is the name order.
 */
function assignSlots() {
  /** @type {Map<string, FrameRec[]>} */
  const groups = new Map();
  for (const rec of frames.values()) {
    if (rec.preview || rec.closed) continue;
    const slot = preferredSlot(rec);
    if (!slot) continue;
    if (!groups.has(slot)) groups.set(slot, new Map());
    // one entry per plugin: a repeatable slot has one frame per host
    if (!groups.get(slot).has(rec.pluginId)) groups.get(slot).set(rec.pluginId, rec);
  }
  for (const [slot, byId] of groups) {
    const list = [...byId.values()].sort(byPluginName);
    const want = chosenSlot.get(slot);
    const pick = (want && list.find((r) => r.pluginId === want)) || list[0];
    if (slots.isRepeatable(slot)) {
      // shared: every plugin that prefers it holds it
      for (const rec of list) if (slots.slotOf(rec.pluginId) !== slot) slots.request(rec.pluginId, slot, rec.declared);
      continue;
    }
    if (slots.holder(slot) !== pick.pluginId) {
      const holder = slots.holder(slot);
      if (holder) slots.release(holder);
      if (slots.slotOf(pick.pluginId)) slots.release(pick.pluginId);
      slots.request(pick.pluginId, slot, pick.declared);
    }
    for (const rec of list) if (rec.pluginId !== pick.pluginId && slots.slotOf(rec.pluginId) === slot) slots.release(rec.pluginId);
  }
}

/** Tabs for a slot that more than one switched-on plugin prefers. One is visible; the rest are listed here. */
function renderSlotTabs() {
  for (const slot of UI_SLOTS) {
    // an aliased name has no element of its own: the target's pass renders the tabs, so no double set
    if (UI_SLOT_ALIASES[slot]) continue;
    // a repeatable slot has one frame per host and every plugin may hold it: there is nothing to switch between
    if (slots.isRepeatable(slot)) continue;
    const el = hostOf(slot);
    if (!el) continue;
    const seen = new Set();
    const list = [];
    for (const rec of frames.values()) {
      if (rec.preview || rec.closed || seen.has(rec.pluginId)) continue;
      if (preferredSlot(rec) !== slot) continue;
      seen.add(rec.pluginId);
      list.push(rec);
    }
    list.sort(byPluginName);
    const old = el.querySelector(':scope > .ui-slot__tabs');
    if (list.length < 2) { if (old) old.remove(); continue; }
    const bar = old || document.createElement('div');
    bar.className = 'ui-slot__tabs';
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', t('界面插件'));
    const holder = slots.holder(slot);
    bar.replaceChildren(...list.map((rec) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ui-slot__tab';
      b.setAttribute('role', 'tab');
      const label = pluginName(rec.entry) || rec.pluginId;
      b.textContent = label;
      b.title = label;
      b.setAttribute('aria-selected', holder === rec.pluginId ? 'true' : 'false');
      b.addEventListener('click', () => {
        chosenSlot.set(slot, rec.pluginId);
        assignSlots();
        for (const frame of frames.values()) place(frame);
        renderSlotTabs();
      });
      return b;
    }));
    if (!old) el.prepend(bar);
  }
}

function placeAll() {
  assignSlots();
  for (const rec of frames.values()) place(rec);
  renderSlotTabs();
}

/** How many plugins are mounted (instances of one plugin count once). */
function pluginCount() {
  const ids = new Set();
  for (const rec of frames.values()) ids.add(rec.pluginId);
  return ids.size;
}

/**
 * Create one frame. `place` moves it into its host. A repeatable slot calls this once per host element, each instance
 * with its own key (`<pluginId>#<hostKey>`) and host, so every card gets the panel.
 * @param {any} entry @param {any} preview
 * @param {{ recId: string, hostKey: string | null, host: Element | null, declared: string[],
 *   src: string, entries: Record<string, string> }} plan
 */
function createFrame(entry, preview, plan) {
  const id = plan.recId;
  const iframe = document.createElement('iframe');
  iframe.className = 'ui-slot__frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.referrerPolicy = 'no-referrer';
  iframe.setAttribute('credentialless', '');
  iframe.setAttribute('allow', '');
  iframe.title = pluginName(entry) || entry.id;
  iframe.dataset.plugin = entry.id;
  iframe.dataset.rec = id;
  /** @type {FrameRec} */
  const rec = { id, pluginId: entry.id, hostKey: plan.hostKey, host: plan.host, iframe, declared: plan.declared, entry,
    ready: false, preview, entries: plan.entries, limitAt: 0, loads: 0, closed: false };
  frames.set(id, rec);
  iframe.addEventListener('load', () => {
    if (frames.get(id) !== rec || rec.closed) return;
    rec.loads += 1;
    const decision = frameLoadDecision(rec.loads);
    if (decision === 'destroy') { stopForLeaving(entry.id); return; }
    // The entry document. welcome does not include the private view; ready (accepted only at this count) does.
    // `net` is not the private view: the panel reads it during mount, before ready.
    if (decision === 'entry') {
      if (!rec.preview) postNetNow(rec);
      post(rec, hostWelcome(entry.id, plan.declared, rec.preview ? undefined : welcomeInfo(rec), plan.hostKey));
    }
  });
  iframe.src = plan.src;
  place(rec);
}

/** @param {any} entry */
function mount(entry, preview = null) {
  const id = entry.id;
  if (framesOf(id).length || pluginCount() >= UI_LIMITS.maxPlugins) return;
  const rel = typeof entry.entry === 'string' ? entry.entry : null;
  const sha = rel && entry.frameFiles && typeof entry.frameFiles[rel] === 'string' ? entry.frameFiles[rel] : null;
  const src = rel && sha ? framePageUrl(id, rel, sha) : null;
  if (!src) return;
  const declared = Array.isArray(entry.slots) ? entry.slots.filter((s) => typeof s === 'string') : [];
  // the hosts this page renders for the declared slots: a repeatable slot names one key per host (its own card)
  const hosts = {};
  for (const s of declared) {
    if (!UI_SLOTS.includes(s)) continue;
    hosts[s] = slots.isRepeatable(s) ? hostsOf(s).map((h) => (h.dataset && h.dataset.uiHostKey) || '').filter(Boolean) : [];
  }
  const plan = planMount({ declared, hosts, isRepeatable: slots.isRepeatable, holder: slots.holder });
  if (plan && !slots.request(id, plan.slot, declared).ok) return;
  const entries = preview ? Object.create(null) : loadEntries(id);
  // a preview mounts into the host it was given, never once per card
  if (plan && plan.repeatable && !preview && plan.keys.length) {
    for (const key of plan.keys) {
      const host = hostOf(plan.slot, key);
      createFrame(entry, preview, { recId: `${id}#${key}`, hostKey: key, host, declared, src, entries });
    }
    return;
  }
  createFrame(entry, preview, { recId: id, hostKey: null, host: null, declared, src, entries });
}

/** @param {string} id @returns {Record<string, string>} */
function loadEntries(id) {
  /** @type {Record<string, string>} */
  const entries = Object.create(null);
  const prefix = `sp.plugin.${id}.`;
  let ls;
  try { ls = globalThis.localStorage; } catch { return entries; }
  if (!ls) return entries;
  try {
    for (let i = 0; i < ls.length; i++) {
      const full = ls.key(i);
      if (!full || !full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      if (!namespacedStorageKey(id, key)) continue;
      const raw = ls.getItem(full);
      if (raw != null) entries[key] = raw;
    }
  } catch { /* privacy mode */ }
  return entries;
}

/** Scalar prefs already in the host page's storage. Objects are not sent. Intent-typed keys are not sent. */
function welcomeInfo(rec) {
  const room = subsetRoom(store.get().room);
  /** @type {Record<string, string | number | boolean>} */
  const prefs = {};
  let n = 0;
  for (const key of Object.keys(rec.entries || {})) {
    if (n >= 32) break;
    if (isIntentType(key)) continue;
    let value;
    try { value = JSON.parse(rec.entries[key]); } catch { continue; }
    if (typeof value === 'string') {
      if (value.length > 4096) continue;
      prefs[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) prefs[key] = value;
    else if (typeof value === 'boolean') prefs[key] = value;
    else continue;
    n += 1;
  }
  return {
    version: PROTOCOL_VERSION,
    lang: getLang(),
    plugins: room && Array.isArray(room.plugins) ? room.plugins : [],
    cs: room && room.cs,
    prefs,
  };
}

/** @param {FrameRec} rec */
function postNetNow(rec) {
  if (rec.netAt != null) return;
  const msg = hostNet(store.get().connection);
  try { rec.netText = JSON.stringify(msg); } catch { return; }
  rec.netAt = Date.now();
  post(rec, msg);
}

function scheduleState() {
  if (stateTimer) return;
  stateTimer = window.setTimeout(() => {
    stateTimer = 0;
    const s = store.get();
    const m = s.match;
    const msg = hostState(m && m.public, m && m.private, s.room);
    let text = '';
    try { text = JSON.stringify(msg); } catch { return; }
    if (text === lastState) return;
    lastState = text;
    for (const rec of frames.values()) if (feeding(rec)) post(rec, msg);
  }, STATE_MS);
}

function scheduleNet() {
  if (netTimer) return;
  const msg = hostNet(store.get().connection);
  let text = '';
  try { text = JSON.stringify(msg); } catch { return; }
  const now = Date.now();
  let wait = Infinity;
  // Delivery is tracked per document: initializing a sibling must not consume a pending broadcast.
  for (const rec of frames.values()) {
    if (!feeding(rec) || rec.preview || text === rec.netText) continue;
    const slot = netSlot(rec.netAt, now, Math.round(1000 / UI_LIMITS.netHz));
    if (!slot.send) { wait = Math.min(wait, slot.wait); continue; }
    rec.netAt = now;
    rec.netText = text;
    post(rec, msg);
  }
  if (Number.isFinite(wait)) netTimer = window.setTimeout(() => { netTimer = 0; scheduleNet(); }, wait);
}

function scheduleResult() {
  const m = store.get().match;
  const msg = hostResult(m && m.result);
  let text = '';
  try { text = JSON.stringify(msg); } catch { return; }
  if (text === lastResultText) return;
  lastResultText = text;
  for (const rec of frames.values()) if (feeding(rec) && !rec.preview) post(rec, msg);
}

function flushBattle() {
  battleTimer = 0;
  const events = battleQueue;
  battleQueue = [];
  const msg = battlePayload({ fieldId: battleField, gt: battleGt, events, snap: lastSnap });
  for (const rec of frames.values()) if (feeding(rec)) post(rec, msg);
}

function scheduleBattle() {
  if (battleTimer) return;
  battleTimer = window.setTimeout(flushBattle, SLOT_MS);
}

/** @param {FrameRec} rec */
function noteLimit(rec) {
  const now = Date.now();
  if (now - rec.limitAt < LIMIT_MS) return;
  rec.limitAt = now;
  post(rec, hostLimit('rate'));
  try { toast(t('界面插件发送得太快，请稍后再试'), 'warn'); } catch { /* the toast host may be absent */ }
}

/** @param {FrameRec} rec @param {Record<string, unknown>} msg */
function onStorage(rec, msg) {
  const op = msg.op;
  const key = typeof msg.key === 'string' ? msg.key : '';
  if (op === 'keys') {
    post(rec, { v: 1, t: 'storage', op: 'keys', keys: Object.keys(rec.entries), ok: true });
    return;
  }
  const full = namespacedStorageKey(rec.pluginId, key);
  if (!full) {
    post(rec, { v: 1, t: 'storage', op, key, ok: false, error: UI_ERRORS.PLUGIN_STORAGE });
    return;
  }
  if (op === 'get') {
    const text = rec.entries[key];
    if (text == null) {
      post(rec, { v: 1, t: 'storage', op: 'get', key, value: null, ok: true });
      return;
    }
    try {
      post(rec, { v: 1, t: 'storage', op: 'get', key, value: JSON.parse(text), ok: true });
    } catch {
      post(rec, { v: 1, t: 'storage', op: 'get', key, ok: false, error: UI_ERRORS.PLUGIN_STORAGE });
    }
    return;
  }
  if (op === 'delete') {
    delete rec.entries[key];
    try { if (!rec.preview) globalThis.localStorage?.removeItem(full); } catch { /* ignore */ }
    post(rec, { v: 1, t: 'storage', op: 'delete', key, ok: true });
    return;
  }
  const checked = checkStorageWrite(rec.entries, key, msg.value);
  if (!checked.ok) {
    post(rec, { v: 1, t: 'storage', op: 'set', key, ok: false, error: checked.error });
    return;
  }
  rec.entries[key] = checked.text;
  try { if (!rec.preview) globalThis.localStorage?.setItem(full, checked.text); } catch {
    delete rec.entries[key];
    post(rec, { v: 1, t: 'storage', op: 'set', key, ok: false, error: UI_ERRORS.PLUGIN_STORAGE });
    return;
  }
  post(rec, { v: 1, t: 'storage', op: 'set', key, ok: true });
}

/** @param {FrameRec} rec @param {Record<string, unknown>} msg */
function handle(rec, msg) {
  if (msg.t === 'ready') {
    // Only the entry document may initialize, once. Duplicate ready must not bypass feed throttling.
    // welcome is posted from the load handler, not from here, so a plugin that answers welcome cannot loop.
    if (rec.ready || frameLoadDecision(rec.loads) !== 'entry') return;
    rec.ready = true;
    const live = store.get();
    const m = rec.preview?.state || live.match;
    post(rec, hostState(m && m.public, m && m.private, rec.preview ? undefined : live.room));
    if (!rec.preview) {
      postNetNow(rec);
      scheduleNet();
      const result = hostResult(m && m.result);
      post(rec, result);
    }
    return;
  }
  if (msg.t === 'slot') {
    const r = slots.request(rec.pluginId, /** @type {string} */ (msg.slot), rec.declared);
    post(rec, { v: 1, t: 'slot', slot: msg.slot, ok: r.ok === true, ...(r.ok ? {} : { error: r.error }) });
    if (r.ok) place(rec);
    return;
  }
  if (msg.t === 'resize') {
    const h = clampHeight(/** @type {number} */ (msg.height));
    if (h == null) { post(rec, hostRejected('shape')); return; }
    rec.iframe.style.height = `${h}px`;
    return;
  }
  if (msg.t === 'notice') {
    const text = clampNotice(msg.text);
    if (!text) { post(rec, hostRejected('shape')); return; }
    // A different line waits 2s. The same line still reaches the toast host, which merges it. No toast on the limit
    // itself (the token-bucket warning already has its own 2s debounce).
    if (!noticeLimiter.allow(rec.id, text)) { post(rec, hostLimit('notice')); return; }
    try { toast(text, 'info'); } catch { /* ignore */ }
    return;
  }
  if (msg.t === 'stats') {
    const unitId = /** @type {number} */ (msg.unitId);
    const fieldId = typeof msg.fieldId === 'string' ? msg.fieldId : null;
    let stats = null;
    try {
      stats = rec.preview ? { dmg: 120, heal: 0, taken: 0 } : battleRunner && typeof battleRunner.unitStats === 'function' ? battleRunner.unitStats(unitId, fieldId) : null;
    } catch { stats = null; }
    post(rec, { v: 1, t: 'stats', unitId, fieldId, stats: stats && typeof stats === 'object' ? stats : null });
    return;
  }
  if (msg.t === 'storage') { onStorage(rec, msg); return; }
  if (msg.t === 'intent') {
    // A content panel asks for one gameplay action (g.*) or for its own match plugin (p.msg). `plugin` is always the
    // frame's own id — a panel cannot speak for another plugin — and the socket validates the message again
    // (shared/protocol.js validateC2S), so a panel can only do what this player could click.
    const inner = msg.msg && typeof msg.msg === 'object' ? msg.msg : null;
    if (!inner || typeof inner.t !== 'string') { post(rec, hostRejected('shape')); return; }
    const fields = { ...inner };
    const type = fields.t;
    delete fields.t;
    if (type === 'p.msg') fields.plugin = rec.pluginId;
    try { net.send(type, fields); } catch { /* offline: the panel learns it from the net frames */ }
    return;
  }
}

function onWindowMessage(ev) {
  let rec = null;
  for (const item of frames.values()) {
    if (item.iframe.contentWindow && item.iframe.contentWindow === ev.source) { rec = item; break; }
  }
  if (!rec) return;
  if (ev.origin !== 'null') return;
  const verdict = validatePluginMessage(ev.data);
  const allowed = limiter.allow(rec.id);
  if (!verdict.ok && verdict.reason === 'intent') {
    if (rejected.length < 50) rejected.push('intent');
    post(rec, hostRejected('intent'));
  }
  if (!allowed) { noteLimit(rec); return; }
  if (!verdict.ok) {
    if (verdict.reason !== 'intent') post(rec, hostRejected(verdict.reason));
    return;
  }
  const msg = verdict.msg;
  // The child's script runs before the parent's load event, and postMessage is queued before that load.
  // Applying the message on the next turn lets a navigation that already queued its load destroy the frame first,
  // so ready on the new document does not pull state. A task that was queued even earlier can still post once
  // (DESIGN §32.8 [ASSUMED]).
  setTimeout(() => {
    if (frames.get(rec.id) !== rec || rec.closed) return;
    if (frameLoadDecision(rec.loads) === 'destroy') { stopForLeaving(rec.pluginId); return; }
    handle(rec, msg);
  }, 0);
}

function sync() {
  const ids = uiPlugins.get().ids;
  if (!ids.length) { destroyAll(); return; }
  if (!installedCount(store.get())) return;
  const cat = catalog.get();
  if (cat.status !== 'ready') {
    if (cat.status !== 'loading') loadCatalog();
    return;
  }
  const entries = uiPluginEntries(cat.plugins);
  const want = [];
  for (const id of ids) {
    if (want.length >= UI_LIMITS.maxPlugins) break;
    if (blocked.has(id)) continue;
    if (entries.some((p) => p.id === id)) want.push(id);
  }
  const keep = new Set(want);
  for (const rec of [...frames.values()]) if (!keep.has(rec.pluginId)) destroy(rec.id);
  for (const id of want) {
    if (!framesOf(id).length) mount(entries.find((p) => p.id === id));
  }
  placeAll();
}

function boot() {
  if (booted || typeof window === 'undefined' || typeof document === 'undefined') return;
  booted = true;
  globalThis.__SP_UI_PLUGINS__ = api;
  window.addEventListener('message', onWindowMessage);
  const obs = new MutationObserver((records) => {
    let changed = false;
    for (const rec of records) {
      for (const node of rec.removedNodes) if (rescue(node)) changed = true;
      for (const node of rec.addedNodes) {
        if (node.nodeType !== 1) continue;
        const el = /** @type {Element} */ (node);
        if ((el.getAttribute && el.getAttribute('data-ui-slot')) || (el.querySelector && el.querySelector('[data-ui-slot]'))) changed = true;
      }
    }
    if (changed) placeAll();
  });
  const arm = () => {
    if (!document.body) return;
    parkEl();
    obs.observe(document.body, { childList: true, subtree: true });
    sync();
  };
  if (document.body) arm();
  else document.addEventListener('DOMContentLoaded', arm, { once: true });
  uiPlugins.subscribe(() => sync());
  catalog.subscribe(() => sync());
  store.subscribe((s, prev) => {
    if (!prev || s.installedPlugins !== prev.installedPlugins) sync();
    if (!prev || s.match !== prev.match || s.room !== prev.room) scheduleState();
    if (!prev || s.connection !== prev.connection) scheduleNet();
    if (!prev || s.match !== prev.match || (s.match && prev.match && s.match.result !== prev.match.result)) scheduleResult();
  });
  if (battleRunner && typeof battleRunner.on === 'function') {
    battleRunner.on('ev', (payload) => {
      const list = payload && Array.isArray(payload.ev) ? payload.ev : [];
      for (const ev of list) battleQueue.push(ev);
      while (battleQueue.length > UI_LIMITS.battleBatch) battleQueue.shift();
      if (payload && typeof payload.fieldId === 'string') battleField = payload.fieldId;
      if (payload && typeof payload.gt === 'number') battleGt = payload.gt;
      scheduleBattle();
    });
    battleRunner.on('snap', (frame) => {
      lastSnap = frame;
      if (frame && typeof frame.fieldId === 'string') battleField = frame.fieldId;
      if (frame && typeof frame.gt === 'number') battleGt = frame.gt;
      scheduleBattle();
    });
  }
}

/** Studio preview through the exact game host. [ASSUMED] Only fake state and volatile storage; never gameplay data. */
export function mountPluginPreview(entry, host) {
  if (!host || !entry || entry.class !== 'ui') return null;
  destroy(entry.id);
  const preview = { host, state: { public: { phase: 'COMBAT', round: 1, players: [] }, private: { playerId: 'preview', funds: 10 } } };
  mount(entry, preview);
  const rec = frames.get(entry.id);
  if (!rec) return null;
  let gt = 0;
  const timer = setInterval(() => {
    if (!feeding(rec)) return;
    gt += 1;
    post(rec, battlePayload({ fieldId: 'preview', gt, events: [['dmg', 1, 120, 'phys']], snap: null }));
  }, 1000);
  return { close() { clearInterval(timer); if (frames.get(entry.id) === rec) destroy(entry.id); } };
}

boot();
