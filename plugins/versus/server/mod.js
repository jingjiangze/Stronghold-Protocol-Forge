// versus/server/mod.mjs — 2V2 对抗 matchClass 包装器
//
// 引擎侧（gpt/versus-constants 分支）已提供：ROOM_MODES 含 versus、g.confront 等协议、
// room.swapSeats、confrontTraits.js。本 matchClass 在此基础上：
//   1. 识别 versus 房（this.mode === 'versus'）
//   2. 初始化队伍状态（每队的座位映射与共享 LP 占位）
//   3. 处理 g.confront / g.confrontTarget 通道命令（基础状态记录）
//
// 完整的 confront 状态机（预算计算、波次替换、per-team 隔离）属引擎侧后续步骤。

const VERSUS_MODE = 'versus';
const CONFRONT_TARGET = 2; // 先到 2 胜的系列赛目标（预留）

export function registerServer(host) {
  host.matchClass((Base) => class VersusMatch extends Base {
    /** versus 状态：随 Match 实例销毁 */
    __vs() {
      if (!this.__vsState) {
        this.__vsState = {
          teams: { 0: [], 1: [] },
          targets: {},       // playerId → targetPlayerId
          submissions: {},   // playerId → { group, position, picks, bosses }
          series: 0,
          wins: { 0: 0, 1: 0 },
          over: false,
        };
      }
      return this.__vsState;
    }

    _isVersus() { return this.mode === VERSUS_MODE; }

    _initTeams() {
      const st = this.__vs();
      if (st.teams[0].length) return; // already init'd
      for (const ps of this.players.values()) {
        const team = Math.floor((ps.seat ?? 0) / 2) % 2;
        st.teams[team].push(ps.playerId);
        ps.team = team;
      }
    }

    handlePackMsg(playerId, msg) {
      if (!msg || msg.pack !== 'versus') return undefined;
      if (!this._isVersus()) return undefined;
      const st = this.__vs();
      this._initTeams();

      if (msg.channel === 'confrontTarget') {
        const target = msg.data?.targetPlayerId;
        if (!target || typeof target !== 'string') return true;
        // 只能指定对方队伍的玩家
        const myTeam = st.teams[0].includes(playerId) ? 0 : 1;
        const otherTeam = myTeam === 0 ? 1 : 0;
        if (!st.teams[otherTeam].includes(target)) return true;
        st.targets[playerId] = target;
        return true; // 消费：状态走视图
      }

      if (msg.channel === 'confront') {
        const d = msg.data;
        if (!d || typeof d !== 'object') return true;
        st.submissions[playerId] = {
          group: d.group ?? null,
          position: d.position ?? 'mid',
          picks: Array.isArray(d.picks) ? d.picks.slice(0, 64) : [],
          bosses: Array.isArray(d.bosses) ? d.bosses.slice(0, 32) : [],
        };
        return true;
      }

      return undefined;
    }

    startRound(r) {
      const out = super.startRound(r);
      if (this._isVersus()) this._initTeams();
      return out;
    }

    publicView() {
      const view = super.publicView?.() ?? {};
      if (this._isVersus()) {
        const st = this.__vs();
        view.versus = {
          teams: st.teams,
          targets: st.targets,
          series: st.series,
          wins: { ...st.wins },
          over: st.over,
        };
      }
      return view;
    }
  });

  host.healthz(() => ({
    versusPack: 'versus',
    versusTarget: CONFRONT_TARGET,
  }));
}
