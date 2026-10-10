// mod-xie/client/econ.js — 促融共竞的对局内 HUD（`screen.game.hud` 面板）。
//
// 注入面就是引擎给的那一份（DESIGN §28.8）：`host`（一个容器元素）、`net`（`on` / `send`）、`me`（只读会话快照）、
// `data`（声明过的数据表）、`log`。**没有 store、没有 match** —— 界面读的状态全部来自引擎推给这一端的
// `m.public` / `m.private` 两帧（本包的服务端在视图里加了 `econ` 键，这是能力探针），动作走本包自己的通道
// （`pack.msg`，服务端的 `Match.handlePackMsg` 收）。
//
// 第一版刻意小：一条经济条 + 借还牌 + 项目 / 救济 / 救援按钮。样式表（`client/econ.css`）与更完整的卡面是
// PENDING —— 见 README「完成度」。**本文件尚未在浏览器里实跑过**（与 v1 的整条交互链同一项 PENDING）。

export function mount(ctx) {
  const doc = ctx.host.ownerDocument;
  const box = doc.createElement('div');
  box.className = 'modxie-econ';
  box.style.cssText = 'position:absolute;left:8px;top:8px;z-index:40;font-size:12px;pointer-events:auto;'
    + 'background:rgba(0,0,0,.55);color:#eee;border-radius:6px;padding:4px 8px;line-height:1.5;max-width:340px';
  ctx.host.appendChild(box);

  /** 面板自己的两个读数（任一帧到就重画）。 */
  const state = { pub: null, priv: null };

  const send = (channel, data) => ctx.net.send(channel, data);
  const button = (label, onClick) => {
    const b = doc.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:1px 3px;font-size:11px;cursor:pointer';
    b.addEventListener('click', onClick);
    return b;
  };

  function render() {
    box.textContent = '';
    const pub = state.pub && state.pub.econ;
    const priv = state.priv && state.priv.econ;
    if (!pub && !priv) { box.textContent = '促融共竞'; return; }   // 规则集没开：不渲染任何经济行

    const line = (text) => { const d = doc.createElement('div'); d.textContent = text; box.appendChild(d); return d; };
    if (pub) {
      line(`团队储备 ${pub.reserve ?? 0}`);
      if (Array.isArray(pub.requests) && pub.requests.length) {
        line(`进行中的借调：${pub.requests.length}`);
      }
    }
    if (priv) {
      line(`资金 ${priv.funds ?? '?'}${priv.owe && priv.owe.length ? ` · 欠 ${priv.owe.length} 笔` : ''}`);
      // 收到别人的借款请求：逐条给「借 / 拒」
      const incoming = Array.isArray(priv.requestIn) ? priv.requestIn : [];
      for (const req of incoming) {
        const row = doc.createElement('div');
        row.textContent = `${req.fromName || req.from} 想借 ${req.amount}`;
        row.appendChild(button('借', () => send('answer', { id: req.id, approve: true })));
        row.appendChild(button('拒', () => send('answer', { id: req.id, approve: false })));
        box.appendChild(row);
      }
      // 自己的请求：撤回一条也没有（服务端在 ready / 回合结束会关单），这里只显示
      const mine = Array.isArray(priv.myRequests) ? priv.myRequests : [];
      for (const req of mine) line(`已向 ${req.toName || req.to} 借 ${req.amount}（等待应答）`);
      // 动作行
      const actions = doc.createElement('div');
      actions.appendChild(button('救济', () => send('relief', {})));
      if (priv.canRelief === false) actions.lastChild.disabled = true;
      if (priv.projects && Array.isArray(priv.projects)) {
        for (const p of priv.projects) {
          actions.appendChild(button(`${p.name || p.id} Lv${p.level}（${p.price}）`, () => send('project', { project: p.id })));
        }
      }
      box.appendChild(actions);
      // 救援：窗口开着且有目标时给一个「捐 LP」按钮
      if (priv.revival && priv.revival.canDonate && Array.isArray(priv.revival.targets)) {
        const row = doc.createElement('div');
        row.textContent = `救援窗口（花费 ${priv.revival.cost} LP）`;
        for (const t of priv.revival.targets) {
          row.appendChild(button(`救 ${t.name || t.playerId}`, () => send('revive', { round: priv.revival.round, playerId: t.playerId })));
        }
        box.appendChild(row);
      }
    }
  }

  const onPub = ctx.net.on('m.public', (view) => { state.pub = view || null; render(); });
  const onPriv = ctx.net.on('m.private', (view) => { state.priv = view || null; render(); });
  render();

  return {
    unmount() {
      onPub();
      onPriv();
      box.remove();
    },
  };
}
