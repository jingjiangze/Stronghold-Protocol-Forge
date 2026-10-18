// server/mota/rules.js — the resolved rule sets of a room whose mode carries a `mota` block.
//
// The rule code lives here rather than in server/match/gamedata.js so that upstream file only grows the hook calls in
// the table of FINDINGS.md §2.2. A room without a `mota` block resolves to null and every hook is inert.

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const nn = (v, dflt) => (Number.isInteger(v) && v >= 0 ? v : dflt);
const pi = (v, dflt) => (Number.isInteger(v) && v > 0 ? v : dflt);
const costs = (v, dflt) => (Array.isArray(v) && v.length ? v.slice(0, 4) : dflt).map((x) => (Number.isFinite(x) && x >= 0 ? Math.trunc(x) : 0));

/** The shipped starting values (魔塔 §28/§29). A mode's own block overrides any of them. */
export const MOTA_DEFAULTS = Object.freeze({
  teamEconomy: {
    transfer: { maxPerRequest: 5, requestsPerRound: 1, teamCapPerRound: 8, ttlSec: 30, repayInterest: 0 },
    deathDividend: { enabled: false, dice: 6 },
    coverInterest: { enabled: false, capPct: 100, lagPremium: 1 },
    botLend: { enabled: false, basePct: 10, weakPct: 20, solventPct: 10, coverPct: 10, maxPct: 50, tightFactorPct: 50, delayMsMin: 600, delayMsMax: 2200 },
    botAsk: { enabled: false, basePct: 8, brokePct: 40, keyPct: 60, maxPct: 50, keyMaxPct: 80 },
    reserve: { convertPerPlayerMax: 2, perfectReward: 1, perfectRewardCapPerRound: 2 },
    relief: { enabled: false, amount: 1, lpThreshold: 10, perPlayerPerRound: 2, teamPerRound: 4 },
    projects: {
      procure: { costs: [4, 8, 12] },
      storehouse: { costs: [4, 4, 4] },
      logistics: { costs: [4, 4, 4], teamCapBonus: [4, 8, 12], extraRequestsAtL3: 1 },
    },
  },
  revival: { enabled: false, costPer: 5, step: 5 },
});

/** The room's `mota` block, or null. Solo never has one (the module is a co-op rule set). */
export function motaBlock(gd) {
  if (!gd || gd.isSolo) return null;
  const block = obj(gd.mode && gd.mode.mota);
  return block.enabled === true ? block : null;
}

/** The resolved 协同经济 rule set, or null while it is off. */
export function economyRules(gd) {
  const block = motaBlock(gd);
  if (!block) return null;
  const src = obj(block.teamEconomy);
  if (src.enabled !== true) return null;
  const d = MOTA_DEFAULTS.teamEconomy;
  const tr = obj(src.transfer);
  const rv = obj(src.reserve);
  const rl = obj(src.relief);
  const pj = obj(src.projects);
  const project = (id) => {
    const cur = obj(pj[id]);
    const def = d.projects[id];
    const out = { costs: costs(cur.costs, def.costs) };
    if (def.teamCapBonus) out.teamCapBonus = costs(cur.teamCapBonus, def.teamCapBonus);
    if (Number.isInteger(def.extraRequestsAtL3)) out.extraRequestsAtL3 = nn(cur.extraRequestsAtL3, def.extraRequestsAtL3);
    return out;
  };
  return {
    borrowOnly: src.borrowOnly === true,
    transfer: {
      maxPerRequest: pi(tr.maxPerRequest, d.transfer.maxPerRequest),
      requestsPerRound: pi(tr.requestsPerRound, d.transfer.requestsPerRound),
      teamCapPerRound: pi(tr.teamCapPerRound, d.transfer.teamCapPerRound),
      ttlSec: pi(tr.ttlSec, d.transfer.ttlSec),
      repayInterest: nn(tr.repayInterest, d.transfer.repayInterest),
    },
    deathDividend: (() => {
      const dd = obj(src.deathDividend);
      return { enabled: dd.enabled === true, dice: Math.max(2, Math.min(100, pi(dd.dice, d.deathDividend.dice))) };
    })(),
    coverInterest: (() => {
      const ci = obj(src.coverInterest);
      return {
        enabled: ci.enabled === true,
        capPct: Math.max(0, Math.min(100, nn(ci.capPct, d.coverInterest.capPct))),
        lagPremium: Math.max(1, Math.min(4, pi(ci.lagPremium, d.coverInterest.lagPremium))),
      };
    })(),
    botAsk: (() => {
      const ba = obj(src.botAsk);
      const pct = (v, dflt) => Math.max(0, Math.min(100, Math.trunc(Number.isFinite(v) ? v : dflt)));
      const maxPct = pct(ba.maxPct, d.botAsk.maxPct);
      return {
        enabled: ba.enabled === true,
        basePct: Math.min(maxPct, pct(ba.basePct, d.botAsk.basePct)),
        brokePct: pct(ba.brokePct, d.botAsk.brokePct),
        keyPct: pct(ba.keyPct, d.botAsk.keyPct),
        maxPct,
        keyMaxPct: Math.max(maxPct, pct(ba.keyMaxPct, d.botAsk.keyMaxPct)),
      };
    })(),
    botLend: (() => {
      const bl = obj(src.botLend);
      const pct = (v, dflt) => Math.max(0, Math.min(100, Math.trunc(Number.isFinite(v) ? v : dflt)));
      const ms = (v, dflt) => Math.max(0, Math.min(10000, Math.trunc(Number.isFinite(v) ? v : dflt)));
      const maxPct = pct(bl.maxPct, d.botLend.maxPct);
      const lo = ms(bl.delayMsMin, d.botLend.delayMsMin);
      return {
        enabled: bl.enabled === true,
        basePct: Math.min(maxPct, pct(bl.basePct, d.botLend.basePct)),
        weakPct: pct(bl.weakPct, d.botLend.weakPct),
        solventPct: pct(bl.solventPct, d.botLend.solventPct),
        coverPct: pct(bl.coverPct, d.botLend.coverPct),
        maxPct,
        tightFactorPct: pct(bl.tightFactorPct, d.botLend.tightFactorPct),
        delayMsMin: lo,
        delayMsMax: Math.max(lo, ms(bl.delayMsMax, d.botLend.delayMsMax)),
      };
    })(),
    reserve: {
      convertPerPlayerMax: nn(rv.convertPerPlayerMax, d.reserve.convertPerPlayerMax),
      perfectReward: nn(rv.perfectReward, d.reserve.perfectReward),
      perfectRewardCapPerRound: nn(rv.perfectRewardCapPerRound, d.reserve.perfectRewardCapPerRound),
    },
    relief: {
      enabled: rl.enabled === true,
      amount: Math.max(1, Math.min(9, pi(rl.amount, d.relief.amount))),
      lpThreshold: nn(rl.lpThreshold, d.relief.lpThreshold),
      perPlayerPerRound: nn(rl.perPlayerPerRound, d.relief.perPlayerPerRound),
      teamPerRound: nn(rl.teamPerRound, d.relief.teamPerRound),
    },
    projects: Object.fromEntries((() => {
      const named = Object.keys(pj).filter((id) => Object.hasOwn(d.projects, id));
      return named.length ? named : Object.keys(d.projects);
    })().map((id) => [id, project(id)])),
  };
}

/** The resolved 救援 rule set, or null while it is off. */
export function revivalRules(gd) {
  const block = motaBlock(gd);
  if (!block) return null;
  const mode = obj(block.revival);
  if (mode.enabled !== true) return null;
  const d = MOTA_DEFAULTS.revival;
  const pi2 = (v, dflt) => (Number.isInteger(v) && v > 0 ? v : dflt);
  return {
    costPer: pi2(mode.costPer, d.costPer),
    step: (Number.isInteger(mode.step) && mode.step >= 0 ? mode.step : d.step),
  };
}
