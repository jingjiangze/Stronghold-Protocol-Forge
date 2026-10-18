// server/mota/econBot.js — the bot half of the borrow layer, kept out of upstream server/match/bot.js.
//
// The upstream bot module is a 2,000-line decision loop; the mode module only needs one callback (answer a borrow
// request). Porting that callback here keeps the engine file free of economy code and lets the mode ship or drop the
// behaviour on its own.

/** Funds a bot refuses to spend (a `coin_carry_over` band keeps its capital). */
function fundsReserve(m, ps) {
  const gd = m.gd;
  const bands = Array.isArray(gd.leftoverKeptBands) ? gd.leftoverKeptBands : [];
  if (!bands.includes(ps.bandId)) return 0;
  const band = gd.band(ps.bandId);
  const buff = band && Array.isArray(band.buffs) ? band.buffs.find((b) => b && b.key === 'coin_carry_over') : null;
  const cap = Number(buff && buff.bb && buff.bb.capital);
  return Number.isFinite(cap) && cap > 0 ? cap : 5;
}

/**
 * Answer the oldest (or the named) borrow request this bot received. Mirrors the shipped rule:
 * a request the bot cannot spare is refused; otherwise `botLend` (when the mode enables it) rolls a seeded chance and
 * the flat rule approves when the bot keeps a two-fund cushion.
 * @returns {boolean} whether an answer was sent
 */
export function botEconRespond(m, ps, id = null) {
  if (!m.teamEcon) return false;
  const inbox0 = m.econPrivateFor(ps)?.requestIn;
  const inbox = Array.isArray(inbox0) ? inbox0 : (inbox0 ? [inbox0] : []);
  const req = (id != null ? inbox.find((r) => r.id === id) : inbox[0]) || null;
  if (!req) return false;
  const bl = m.teamEcon.botLend;
  // still thinking: this bot's own pause for THIS request (each recipient has its own clock)
  const raw = m.econRequests ? m.econRequests.get(req.id) : null;
  const decideAt = raw && raw.decideAtBy ? raw.decideAtBy.get(ps.playerId) : undefined;
  if (bl && bl.enabled && Number.isFinite(decideAt) && m.sched.now() < decideAt) return false;
  const keep = fundsReserve(m, ps);
  // cannot spare it at all: the server would refuse the transfer anyway (borrowOnly's keep is 0, bands' capital 5)
  if (ps.funds - req.amount < keep) return !!m.econRespond(ps, req.id, false)?.ok;
  let approve;
  if (bl && bl.enabled) {
    let p = m.econBotLendChance(ps, req.from);
    // a loan that would eat the bot's own shopping money is scaled down (the shipped tightFactorPct)
    const cheapest = Math.min(...(ps.shop?.slots || []).filter((s) => s && !s.sold).map((s) => ps.priceOf(s)), Infinity);
    if (Number.isFinite(cheapest) && cheapest > 0 && ps.funds - req.amount - keep < cheapest) {
      p = Math.floor((p * bl.tightFactorPct) / 100);
    }
    approve = m.rngEcon.int(100) < p;
  } else {
    approve = ps.funds - req.amount >= keep + 2;
  }
  return !!m.econRespond(ps, req.id, approve)?.ok;
}
