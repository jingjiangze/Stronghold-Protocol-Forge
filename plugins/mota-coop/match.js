// plugins/mota-coop/match.js — 协同共竞：团队经济 + 救援，作为一个**对局插件**（entry.match）。
//
// 这个文件只做三件事：把规则模块（economy.js / revival.js）绑到本局、把引擎钩子翻译成规则调用、把视图键交回去。
// 规则本身在 economy.js / revival.js 里，和线上包里的那份同源。
//
// `this` 绑定：规则模块是「方法容器」，内部大量 this.xxx 读写对局状态。这里用一个 Proxy 让 this 直接落在 Match 上
// （读走 match、写落 match、方法在容器里就地绑定），所以规则代码不需要为插件改写。

import { PHASE } from '../../shared/constants.js';
import { MatchEconomy } from './economy.js';
import { MatchRevival } from './revival.js';
import { motaBlock } from './rules.js';
import { REVIVAL_WINDOW_MS } from './constants.js';

/** `this` inside the rule modules: the container's methods, everything else delegated to the live match. */
function bindTo(match, container) {
  const self = new Proxy(container, {
    get(target, key, receiver) {
      if (key in target) {
        const v = Reflect.get(target, key, receiver);
        return typeof v === 'function' ? v.bind(self) : v;
      }
      const v = match[key];
      // a method of the match (on its prototype) is bound; an own value that happens to be callable is handed over as
      // is — a match RNG is a function with `.int`/`.pick` on it (createRng), and binding it would drop those
      const own = Object.prototype.hasOwnProperty.call(match, key);
      return typeof v === 'function' && !own ? v.bind(match) : v;
    },
    set(target, key, value) {
      if (key in target) { target[key] = value; return true; }
      match[key] = value;
      return true;
    },
    has(target, key) { return key in target || key in match; },
  });
  return self;
}

/** Flatten a second method container onto the first (both are plain classes of methods). */
function flatten(into, from) {
  for (const key of Object.getOwnPropertyNames(from.prototype)) {
    if (key === 'constructor') continue;
    Object.defineProperty(into, key, Object.getOwnPropertyDescriptor(from.prototype, key));
  }
}

/** @param {any} match the live Match (server/match/Match.js) */
export function activate(match) {
  const block = motaBlock(match.gd);
  if (!block) return null; // the room's mode does not carry a `mota` block: this plugin does nothing here

  const rules = new MatchEconomy();
  flatten(rules, MatchRevival);
  const self = bindTo(match, rules);
  self.econInit();
  self.revivalInit();

  return {
    intents: {
      'g.econ.request': (m, ps, msg) => { const b = msg.body || msg; return self.econRequest(ps, b.to ?? null, b.amount); },
      'g.econ.respond': (m, ps, msg) => { const b = msg.body || msg; return self.econRespond(ps, b.id, b.approve); },
      'g.econ.project': (m, ps, msg) => { const b = msg.body || msg; return self.econBuyProject(ps, b.project); },
      'g.econ.vote': (m, ps, msg) => { const b = msg.body || msg; return self.econVote(ps, b.id, b.approve); },
      'g.econ.relief': (m, ps) => self.econRelief(ps),
      'g.econ.repay': (m, ps, msg) => { const b = msg.body || msg; return self.econRepay(ps, { to: b.to ?? null }); },
      'g.econ.nudge': (m, ps, msg) => { const b = msg.body || msg; return self.econNudge(ps, b.to); },
      'g.revive': (m, ps, msg) => { const b = msg.body || msg; return self.reviveConsent(ps, b.playerId, { round: b.round }); },
    },

    /** LP 0: hold the player for the rescue window instead of eliminating them. */
    defersElimination(m, ps) {
      if (!self.revivalEnabled || !ps || ps.pendingDeath) return false;
      if (self.phase !== PHASE.SETTLE || self.ended || self.disposed || self.teamLp != null) return false;
      if (!self.revivalVoters(ps).length) return false;
      self.revivalDefer(ps);
      return true;
    },

    /** A pending rescue keeps the settle phase open; 0 = the official delay. */
    settleHoldMs() {
      if (!self.revivalEnabled || self.ended || self.disposed) return 0;
      const pending = self.order.filter((ps) => ps.pendingDeath && self.revivalVoters(ps).length);
      return pending.length ? REVIVAL_WINDOW_MS : 0;
    },

    /** The window closed: everyone still pending is eliminated, with the reason recorded. */
    phaseExpired(m, phase) {
      if (phase !== 'settle' || !self.revivalEnabled) return;
      self.revivalFinalizeAll({ reason: 'window-expired' });
    },

    roundStart() {
      self.econNewRound();
      self.econSettleDebts(self.alivePlayers());
    },

    prepEnd(m, alive) {
      self.econCloseAll('prep-end');
      for (const ps of alive) self.econConvertLeftover(ps);
    },

    onLeave(m, playerId) { self.econCloseAllFor(playerId, 'left'); },

    onEliminated(m, ps) { self.econOnEliminated(ps, self.round); },

    publicView() {
      const econ = self.econPublicView();
      const revival = self.revivalView();
      if (!econ && !revival) return null;
      return { ...(econ ? { econ } : {}), ...(revival ? { revival } : {}) };
    },

    privateView(m, ps) {
      const econ = self.econPrivateFor(ps);
      return econ ? { econ } : null;
    },
  };
}

export default activate;
