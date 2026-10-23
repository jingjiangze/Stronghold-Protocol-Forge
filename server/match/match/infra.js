// server/match/match/infra.js — Match methods: infrastructure — error isolation (guard, reportError), timers tracked
// for dispose (later, cancel, scaled) and the phase deadline (setDeadline), soloUntimed, uids, the player lists
// (alivePlayers, humans), the bonds this match's pool holds (bondInPool, bondLive), a player's boss-round group, deploy
// field and deploy map, and the guarded meta dispatch (dispatch, dispatchItem → effectsMeta.js EffectDispatcher).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { buildDeployMap } from '../board.js';
import { PHASE, opponentRevealed } from '../../../shared/constants.js';

export class MatchInfra {
  /** Run a callback with error isolation, then flush the views. */
  guard(fn) {
    if (this.disposed) return;
    try { fn(); } catch (e) { this.reportError('guard', e); }
    try { this.flush(); } catch (e) { this.reportError('flush', e); }
  }

  reportError(label, e) {
    this.errorCount++;
    const msg = `${label}: ${e && e.message ? e.message : e}`;
    if (this.errors.length < 50) this.errors.push({ label, message: String(e && e.message ? e.message : e), stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : null });
    this.log.error?.(`[match ${this.roomCode}] ${msg}`, e && e.stack ? String(e.stack).split('\n').slice(1, 4).join(' | ') : '');
  }

  /** Schedule a guarded callback (tracked for dispose). */
  later(ms, fn) {
    if (this.disposed) return null;
    let h = null;
    h = this.sched.setTimeout(() => {
      this._timers.delete(h);
      if (this.disposed) return;
      this.guard(fn);
    }, ms);
    if (h) this._timers.add(h);
    return h;
  }

  cancel(h) {
    if (!h) return;
    this.sched.clearTimeout(h);
    this._timers.delete(h);
  }

  scaled(ms) { return Math.max(0, Math.round(ms * this.timerScale)); }

  /**
   * Set the phase deadline (seconds; null/0 ⇒ untimed) and its timeout callback. `silent`: the timer runs but no
   * deadline is published (m.public.deadline 0 ⇒ no countdown) — the fixed presentation steps of a solo match.
   */
  setDeadline(seconds, fn, { silent = false } = {}) {
    this.cancel(this._phaseTimer);
    this._phaseTimer = null;
    if (this.test === true) { this._testHeld = null; this._testArmed = null; }
    // Test matches can hold the callback (g.test timers off). A normal match never enters this branch:
    // scaling the delay to 0 would fire it at once, and cancelling it without keeping fn would stick
    // a phase whose only advance is this timer (BATTLE_CHECK → startRound). [ASSUMED] re-arm uses the
    // original duration, not the leftover.
    if (this.test === true && this.testTimers === false && seconds > 0 && typeof fn === 'function') {
      this.deadline = 0;
      const held = { seconds, fn, silent: !!silent };
      this._testHeld = held;
      this._testArmed = held;
      return;
    }
    if (!(seconds > 0) || typeof fn !== 'function') {
      this.deadline = 0;
      if (this.test === true) { this._testHeld = null; this._testArmed = null; }
      return;
    }
    const ms = this.scaled(seconds * 1000);
    this.deadline = silent ? 0 : this.sched.now() + ms;
    this._phaseTimer = this.later(ms, () => { this._phaseTimer = null; if (this.test === true) { this._testArmed = null; this._testHeld = null; } fn(); });
    if (this.test === true) this._testArmed = { seconds, fn, silent: !!silent };
  }

  /**
   * Solo timers (research 01 §843 / 06 §3: 下半 独立模拟 has no time limit on 休整期 / 机变 — "休整期及机变阶段没有时间
   * 限制"; the strategy draft is free too): a solo match publishes a deadline ONLY for its battles. INFO_CHECK waits
   * for 准备就绪 (co-op keeps the official 25 s guard), BAND_DRAFT / SP_DRAFT / PREP are untimed, and the fixed
   * presentation steps (BATTLE_CHECK, ROUND_START, SETTLE) run silently (no countdown). The same holds for any match
   * with a single human (loneHuman: a 同盟 room started alone or with AI teammates only — user playtest #4 item 3):
   * the timers only ever made humans wait on each other; AI seats act at once.
   */
  get soloUntimed() { return this.isSolo || this.loneHuman; }

  nextUid() { return ++this.uidSeq; }

  alivePlayers() { return this.order.filter((p) => p.alive); }

  /** 2V2 ('versus'): the team a player fights for (PlayerState.team; 0 for solo/coop). */
  teamIdOf(ps) { return ps && Number.isInteger(ps.team) ? ps.team : 0; }

  /** Every player of ps's team, in seat order (solo/coop: the whole roster). */
  alliesOf(ps) { const t = this.teamIdOf(ps); return this.order.filter((p) => this.teamIdOf(p) === t); }

  /** The team ids present in this match, sorted (versus: [0,1]; solo/coop: [0]). */
  matchTeamIds() { return [...new Set(this.order.map((p) => this.teamIdOf(p)))].sort((a, b) => a - b); }

  /**
   * 2V2: whether the opponent's side is open right now — R14 onward (shared/constants.js opponentRevealed), and always
   * at RESULT. Solo/coop have no opponent, so it is always true there.
   */
  get opponentRevealed() { return !this.isVersus || this.phase === PHASE.RESULT || opponentRevealed(this.round); }

  /** Does this match run a 狩猎期 at all? 2V2 对抗期 and 同盟狩猎 both do; solo never does. */
  get huntMode() { return this.isVersus || this.coopHuntOn; }

  /**
   * 2V2: each team shares ONE HP pool = the sum of its members' chosen band HP. The pool REPLACES the individual LP:
   * a team lives and dies as one. Built once every seat has a band (MatchPhases.finishBandDraft); solo/coop never
   * build it and keep their per-player LP untouched. Members' own `ps.lp` are kept as a split of the pool.
   */
  initTeamHp() {
    if (!this.isVersus) return;
    this.teamLps = new Map();
    for (const t of this.matchTeamIds()) {
      let hp = 0;
      for (const ps of this.order) if (this.teamIdOf(ps) === t) hp += Math.max(0, this.gd.startLp(ps.bandId));
      this.teamLps.set(t, hp);
    }
    this.teamLp = [...this.teamLps.values()].reduce((s, v) => s + v, 0);
    this._syncVersusTeamLp();
  }

  /** A team's shared HP pool (versus), or null in solo/coop. */
  teamHpPool(team) { return this.teamLps ? (this.teamLps.get(team) ?? 0) : null; }

  /** Keep each member's own `ps.lp` as a split of its team pool (the pool sums to the same number). */
  _syncVersusTeamLp() {
    if (!this.isVersus || !this.teamLps) return;
    for (const t of this.matchTeamIds()) {
      const pool = this.teamLps.get(t) ?? 0;
      const members = this.order.filter((p) => this.teamIdOf(p) === t);
      const n = members.length || 1;
      const base = Math.floor(pool / n);
      members.forEach((p, i) => { p.lp = base + (i < pool - base * n ? 1 : 0); });
    }
  }

  /** 2V2: deduct from a team's shared pool (never below 0). Returns the pool after the loss. */
  _versusTeamLpLoss(team, loss) {
    if (!this.isVersus || !this.teamLps) return null;
    const before = this.teamLps.get(team) ?? 0;
    const after = Math.max(0, before - Math.max(0, Number(loss) || 0));
    this.teamLps.set(team, after);
    this.teamLp = [...this.teamLps.values()].reduce((s, v) => s + v, 0);
    this._syncVersusTeamLp();
    return after;
  }

  /** Whether any chess of a bond is in this match's pool (a 驰援 card of a fully banned bond is never offered). */
  bondInPool(bondId) {
    for (const id of this.pool.entries.keys()) {
      const c = this.gd.chess(id);
      if (c && Array.isArray(c.bonds) && c.bonds.includes(bondId)) return true;
    }
    return false;
  }

  /**
   * Whether a bond can matter in this match: not in the mode's static inactive list (标准: 拉特兰 / 阿戈尔 / 卡西米尔 /
   * 奥术 … never activate, research 02 §2.1) and still with chess in the pool. 机变 tactic cards whose every target bond
   * is dead are not offered (choices.js).
   */
  bondLive(bondId) {
    return !this.gd.modeInactiveBonds.has(bondId) && this.bondInPool(bondId);
  }
  humans() { return this.order.filter((p) => !p.isBot && !p.left); }

  /** [ASSUMED] Touch's initial, match-long team grant survives its holder's elimination/quit; focus alone grants none. */
  teamMedicGranted() { return this.order.some(p => (this.gd.band(p.bandId)?.effectRef ?? p.bandId) === 'band_amedic'); }

  /**
   * The boss-round group of a player (`bossWaves`: the per-match random pairs, planned in startRound
   * before the players' round start) and its side — 'L', or 'R' for the second player of a pair (the mirrored right
   * half) — or null outside a boss round / for a player without a field.
   * @returns {{ wave: object, players: string[], side: 'L'|'R' } | null}
   */
  bossGroupOf(ps) {
    if (!ps || !Array.isArray(this.bossWaves)) return null;
    const g = this.bossWaves.find((x) => Array.isArray(x.players) && x.players.includes(ps.playerId));
    return g ? { wave: g.wave, players: g.players, side: g.players.indexOf(ps.playerId) === 1 ? 'R' : 'L' } : null;
  }

  /**
   * The field a player deploys on (server/match/board.js DEPLOY_FIELDS): in a boss round (最终攻势 / 隐秘核心, from its
   * ROUND_START on — the pairing exists before PlayerState.startRound's recompute) the player's half of the boss field,
   * 'bossL' or 'bossR' (bossGroupOf); otherwise its own normal board. User playtest #5 item 7.
   * @returns {'normal'|'bossL'|'bossR'}
   */
  deployFieldOf(ps) {
    const g = this.bossGroupOf(ps);
    return !g ? 'normal' : g.side === 'R' ? 'bossR' : 'bossL';
  }

  /**
   * A fresh deploy map of a player on `field` (default: the field it deploys on now) under its device / tile overrides.
   * Pure — no PlayerState cache is touched (the read-only checker invariants.js uses it; PlayerState.deployMap caches).
   */
  deployMapFor(ps, field = this.deployFieldOf(ps)) {
    return buildDeployMap(this.stage, { deviceOverrides: ps.deviceOverrides, tileOverrides: ps.tileOverrides, field });
  }

  dispatch(ps, hook, ev = {}, opts = {}) {
    try { return this.dispatcher.dispatch(ps, hook, ev, opts); } catch (e) { this.reportError(`dispatch ${hook}`, e); return ev; }
  }

  dispatchItem(ps, item, holder, hook, ev) {
    try { return this.dispatcher.dispatchItem(ps, item, holder, hook, ev); } catch (e) { this.reportError(`dispatchItem ${hook}`, e); return ev; }
  }
}
