// Connection banner (global chrome, mounted once by main.js): reconnecting / closed / rejected-hello states with
// the matching action, "正在同步同盟状态…" while a resumed session waits for its room/match state, and "服务器已更新"
// while a match still runs on a page the server has moved past (ui/buildGuard.js sets ui.buildStale). Outside a
// match the banner sits at the bottom centre; in a match (html.sp-in-match, set by the match screen) it moves under the
// top bar so it never covers the combat view switcher or the shop bar. While it shows, html.sp-conn moves the toasts
// below it (classes instead of CSS :has(), which Firefox ESR / Safari < 15.4 lack).

import { html, Button, Icon, useTicker } from './components.js';
import { net, CLIENT_ERR_TEXT } from '../net.js';
import { useStore, shallowEqual } from '../store.js';
import { useDocClass } from './device.js';
import { t } from '../../../shared/i18n.js';
import { P2P_BADGE_AFTER, bannerText, bannerVisible } from './connLogic.js';

// kept exported from here for the existing callers and tests; the rules themselves live in connLogic.js
export { bannerVisible };

export function ConnectionBanner() {
  const conn = useStore((s) => s.connection, shallowEqual);
  const entered = useStore((s) => s.session.entered);
  const restoring = useStore((s) => s.ui.restoring);
  const buildStale = useStore((s) => !!s.ui.buildStale);
  // a page opened through the handshake platform (server/platform.js): a dropped tunnel is not a dropped server
  const p2p = useStore((s) => s.ui.p2p === true);
  useTicker(conn.status === 'reconnecting' ? 500 : 0);
  useDocClass('sp-conn', bannerVisible(conn, entered, restoring, buildStale, p2p));
  if (!entered) return null;
  if (conn.status === 'online' && !restoring && !buildStale) return null;
  if (conn.status === 'online' && restoring) {
    return html`<div class="conn-banner" role="status"><${Icon} name="refresh" /><span>${t('正在同步同盟状态…')}</span></div>`;
  }
  if (conn.status === 'online' && buildStale) {
    // the server has a newer build than this page: the guard reloads by itself once the match is over, the button is
    // for a player who would rather do it now
    return html`<div class="conn-banner" role="alert">
      <${Icon} name="refresh" />
      <span>${t('服务器已更新，本局结束后刷新')}</span>
      <${Button} size="sm" variant="secondary" icon="refresh" onClick=${() => location.reload()}>${t('刷新页面')}<//>
    </div>`;
  }
  if (!conn.everOnline && (conn.status === 'connecting' || conn.status === 'handshaking' || conn.status === 'idle')) return null;
  // p2p: the first attempts are a small badge (the tunnel usually recovers), and it never says the server dropped
  if (p2p && conn.status === 'reconnecting' && (Number(conn.attempt) || 0) < P2P_BADGE_AFTER) {
    return html`<div class="conn-badge" role="status"><${Icon} name="wifiOff" /><span>${bannerText(conn, { p2p })}</span></div>`;
  }
  const secs = conn.retryAt ? Math.max(0, Math.ceil((conn.retryAt - Date.now()) / 1000)) : 0;
  const replaced = conn.status === 'closed' && conn.lastError?.code === 'REPLACED';
  const rejected = conn.status === 'connected' && !!conn.lastError; // hello refused (version, server full…)
  const versionMismatch = rejected && conn.lastError.text === CLIENT_ERR_TEXT.VERSION;
  // Short transitional states (a rename re-sends hello on the live socket) only show if they linger.
  const transient = conn.status === 'connecting' || conn.status === 'handshaking' || (conn.status === 'connected' && !rejected);
  // the wording rules live in connLogic.js: a p2p page says "正在连接房主…" / "房主可能已离线，正在重试"
  const text = bannerText(conn, { p2p, replaced, rejected: rejected ? conn.lastError.text : null });
  const action = conn.status === 'reconnecting' ? { label: t('立即重连'), run: () => net.retryNow() }
    : conn.status === 'closed' ? { label: replaced ? t('在此页面继续') : t('重新连接'), run: () => net.connect() }
      : versionMismatch ? { label: t('刷新页面'), run: () => location.reload() }
        : rejected ? { label: t('重试'), run: () => net.reconnectNow() } : null;
  return html`<div class=${`conn-banner${transient ? ' conn-banner--soft' : ''}`} role="alert">
    <${Icon} name="wifiOff" />
    <span>${text}</span>
    ${conn.status === 'reconnecting' ? html`<span class="conn-banner__sub">${t('第 {attempt} 次 · {secs}s', { attempt: conn.attempt, secs })}</span>` : null}
    ${action ? html`<${Button} size="sm" variant="secondary" icon="refresh" onClick=${action.run}>${action.label}<//>` : null}
  </div>`;
}
