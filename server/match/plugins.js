// server/match/plugins.js — Match methods: the host of a trusted plugin's match module (entry.match).
//
// A match module is `activate(match) → hooks`; the hooks it may return are the only places a plugin touches the match:
//
//   intents     { [type]: (match, ps, msg) → result }   the plugin's own C2S types (shared/protocol.js `p.msg` and any
//                                                       type it registers), routed from MatchIntents._handle
//   roundStart  (match, round)                          after every survivor's PlayerState.startRound
//   prepEnd     (match, alive)                          before PlayerState.endPrep clears funds
//   defersElimination (match, ps) → boolean             true: hold the player instead of eliminating (LP 0)
//   settleHoldMs (match) → number                       > 0: keep the settle phase open that many ms
//   phaseExpired (match, phase)                         the held phase ended (the settle window closed)
//   onEliminated (match, ps)                            after a real elimination (settle, quit, expiry)
//   onLeave     (match, playerId)                       a seat left the room
//   publicView  (match) → object                         merged into m.public
//   privateView (match, ps) → object                     merged into m.private
//   botPrep     (match, ps) → boolean                    true: the plugin answered for this bot
//
// Everything here is inert for a match with no plugins: `_matchPlugins` is a frozen empty list and each hook returns
// its default before touching anything, so a vanilla match's frames stay byte-identical.

import { ERR } from '../../shared/constants.js';
import { fail } from './match/common.js';

const EMPTY = Object.freeze([]);

export class MatchPluginHooks {
  /** Called from the Match constructor once the seats exist (a room with no plugin passes nothing). */
  pluginMatchInit(factories) {
    const list = [];
    for (const f of factories || EMPTY) {
      if (!f || typeof f.activate !== 'function') continue;
      try {
        const hooks = f.activate(this);
        if (hooks && typeof hooks === 'object') list.push({ id: f.id, ...hooks });
      } catch (e) {
        this.reportError?.(`plugin ${f.id}: activate`, e);
      }
    }
    this._matchPlugins = list.length ? list : EMPTY;
  }

  /** Are any match plugins running? Every hook below answers immediately when not. */
  pluginOn() { return this._matchPlugins !== EMPTY && this._matchPlugins.length > 0; }

  /** Run one callback per plugin, isolating a plugin's exception from the match. */
  _pluginEach(fn) {
    if (!this.pluginOn()) return;
    for (const p of this._matchPlugins) {
      try { fn(p); } catch (e) { this.reportError?.(`plugin ${p.id}`, e); }
    }
  }

  /** The plugin's own intent (p.msg and anything it registered). Unknown ⇒ BAD_MSG, as before. */
  pluginIntent(ps, msg) {
    // `p.msg` names the handler in `type`; a plugin may also register a plain C2S type of its own
    const type = msg.t === 'p.msg' ? msg.type : msg.t;
    for (const p of this._matchPlugins || EMPTY) {
      const fn = p.intents && typeof p.intents === 'object' ? p.intents[type] : null;
      if (typeof fn !== 'function') continue;
      // a p.msg that names another plugin is not this plugin's to answer
      if (msg.t === 'p.msg' && msg.plugin && msg.plugin !== p.id) continue;
      try { return fn(this, ps, msg); } catch (e) {
        this.reportError?.(`plugin ${p.id}: ${type}`, e);
        return fail(ERR.INTERNAL);
      }
    }
    return fail(ERR.BAD_MSG);
  }

  /** True when a plugin holds this player at 0 LP instead of eliminating them (救援 and its like). */
  pluginDefersElimination(ps) {
    if (!this.pluginOn()) return false;
    for (const p of this._matchPlugins) {
      if (typeof p.defersElimination !== 'function') continue;
      try { if (p.defersElimination(this, ps)) return true; } catch (e) { this.reportError?.(`plugin ${p.id}: defersElimination`, e); }
    }
    return false;
  }

  /** How long the settle phase stays open for a plugin (0 = the official delay). The longest wins. */
  pluginSettleHoldMs() {
    if (!this.pluginOn()) return 0;
    let max = 0;
    for (const p of this._matchPlugins) {
      if (typeof p.settleHoldMs !== 'function') continue;
      try { const ms = Number(p.settleHoldMs(this)) || 0; if (ms > max) max = ms; } catch (e) { this.reportError?.(`plugin ${p.id}: settleHoldMs`, e); }
    }
    return max;
  }

  pluginPhaseExpired(phase) { this._pluginEach((p) => p.phaseExpired?.(this, phase)); }
  pluginRoundStart(round) { this._pluginEach((p) => p.roundStart?.(this, round)); }
  pluginPrepEnd(alive) { this._pluginEach((p) => p.prepEnd?.(this, alive)); }
  pluginOnLeave(playerId) { this._pluginEach((p) => p.onLeave?.(this, playerId)); }
  pluginOnEliminated(ps) { this._pluginEach((p) => p.onEliminated?.(this, ps)); }

  /** The keys the plugins add to m.public (none ⇒ null, so publicView stays byte-identical). */
  pluginPublicView() {
    if (!this.pluginOn()) return null;
    let out = null;
    for (const p of this._matchPlugins) {
      if (typeof p.publicView !== 'function') continue;
      try {
        const v = p.publicView(this);
        if (v && typeof v === 'object') out = { ...(out || {}), ...v };
      } catch (e) { this.reportError?.(`plugin ${p.id}: publicView`, e); }
    }
    return out;
  }

  /** The keys the plugins add to one seat's m.private. */
  pluginPrivateView(ps) {
    if (!this.pluginOn()) return null;
    let out = null;
    for (const p of this._matchPlugins) {
      if (typeof p.privateView !== 'function') continue;
      try {
        const v = p.privateView(this, ps);
        if (v && typeof v === 'object') out = { ...(out || {}), ...v };
      } catch (e) { this.reportError?.(`plugin ${p.id}: privateView`, e); }
    }
    return out;
  }

  /** A bot's prep step: true when a plugin took it over. */
  pluginBotPrep(ps) {
    if (!this.pluginOn()) return false;
    for (const p of this._matchPlugins) {
      if (typeof p.botPrep !== 'function') continue;
      try { if (p.botPrep(this, ps)) return true; } catch (e) { this.reportError?.(`plugin ${p.id}: botPrep`, e); }
    }
    return false;
  }
}
