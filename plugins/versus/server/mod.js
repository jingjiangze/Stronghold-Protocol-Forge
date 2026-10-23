// versus/server/mod.js — 2V2 对抗期的 matchClass 包装器（薄层）
//
// 引擎侧（gpt/versus-constants 分支）已经承担了对抗期的全部状态机：
//   shared/constants.js   ROOM_MODES 含 'versus'、TEAM_SIZE/TEAMS/teamOfSeat、VERSUS_CONFRONT、COOP_HUNT
//   shared/protocol.js    g.confront / g.confrontTarget / g.confront.withdraw
//   server/match/match/confront.js  预算、分组、名单公示、波次替换、坎诺特取款
//   server/match/match/{infra,views,messaging}.js  队伍池与 per-team 视野隔离
//
// 因此这个包装器只做两件引擎不做的事：
//   1. 在 m.public 上补一个 `versus` 摘要（队伍成员分组），给客户端的大厅/计分板用；
//   2. 暴露 /healthz 的 versus 指纹，便于部署核对插件确实装载。
// 它不复制、不覆盖对抗期状态：任何 super 方法的参数都必须原样透传（publicView 的 viewerTeam 尤其如此，
// 否则 per-team 视野遮蔽会失效）。

const VERSUS_MODE = 'versus';

export function registerServer(host) {
  host.matchClass((Base) => class VersusMatch extends Base {
    _isVersus() { return this.mode === VERSUS_MODE; }

    /** teams: [playerId[] per team] — read straight off the engine's PlayerState.team. */
    _versusTeams() {
      const teams = [[], []];
      for (const ps of this.players.values()) {
        const t = Number.isInteger(ps.team) ? ps.team : 0;
        if (!teams[t]) teams[t] = [];
        teams[t].push(ps.playerId);
      }
      return teams;
    }

    publicView(viewerTeam = null) {
      const view = super.publicView(viewerTeam);
      if (this._isVersus() && view && typeof view === 'object') {
        view.versus = { teams: this._versusTeams() };
      }
      return view;
    }
  });

  host.healthz(() => ({
    versusPack: 'versus',
    versusEngine: 'confront',
  }));
}
