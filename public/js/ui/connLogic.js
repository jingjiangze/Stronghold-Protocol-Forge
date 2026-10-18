// public/js/ui/connLogic.js — the connection banner's rules, without the component (so they can be tested without the
// browser-only preact/htm modules, and so the platform's p2p form can change the wording without touching the layout).
//
// A page opened through the handshake platform carries `&p2p=1` (server/platform.js): the browser is talking to a tunnel
// on this machine, not to a game server of its own. Losing that link means "the host may be offline", not "the server
// dropped you", and a full-screen banner would cover the board for a blip that the tunnel usually recovers from. So:
//   * the first few attempts show a small badge instead of the banner;
//   * from P2P_BADGE_AFTER on, the banner comes back with the host wording.
// Direct (platform-less) pages keep the original behaviour exactly.

import { t } from '../../../shared/i18n.js';

/** After this many reconnect attempts the p2p badge grows back into the full banner. */
export const P2P_BADGE_AFTER = 3;

/**
 * The handshake platform's form flags on the URL (server/platform.js): `p2p=1` — this page came through a tunnel to a
 * host machine; `o2pfallback=1` — the platform sent us to the fallback server because the tunnel was down; `o2pretry=1`
 * — the platform asked us to retry. Purely presentational: they never change how the page connects.
 * @param {string} search
 * @returns {{ p2p: boolean, fallback: boolean, retry: boolean }}
 */
export function parseRelayParam(search) {
  try {
    const q = new URLSearchParams(search || '');
    const on = (k) => q.get(k) === '1' || q.get(k) === 'true';
    const p2p = on('p2p');
    return { p2p, fallback: p2p && on('o2pfallback'), retry: p2p && on('o2pretry') };
  } catch {
    return { p2p: false, fallback: false, retry: false };
  }
}

/**
 * Whether the banner shows for this connection state (mirrors the component's early returns).
 * @param {any} conn the store's connection slice
 * @param {boolean} entered @param {boolean} restoring @param {boolean} [buildStale]
 * @param {boolean} [p2p] the page came through the handshake platform
 */
export function bannerVisible(conn, entered, restoring, buildStale = false, p2p = false) {
  if (!entered || !conn) return false;
  if (conn.status === 'online') return !!restoring || !!buildStale;
  // a quiet first failure of a p2p tunnel: the badge says it, the banner would cover the board
  if (p2p && conn.status === 'reconnecting' && (Number(conn.attempt) || 0) < P2P_BADGE_AFTER) return false;
  if (!conn.everOnline && (conn.status === 'connecting' || conn.status === 'handshaking' || conn.status === 'idle')) return false;
  return true;
}

/**
 * The line the banner (or the p2p badge) shows.
 * @param {any} conn @param {{ p2p?: boolean, replaced?: boolean, rejected?: string|null }} [opts]
 */
export function bannerText(conn, { p2p = false, replaced = false, rejected = null } = {}) {
  if (conn.status === 'reconnecting') {
    if (!p2p) return t('与服务器的连接已中断，正在重连');
    return (Number(conn.attempt) || 0) < P2P_BADGE_AFTER ? t('正在连接房主…') : t('房主可能已离线，正在重试');
  }
  if (replaced) return t('该身份已在其他页面登录');
  if (conn.status === 'closed') return t('连接已关闭');
  if (rejected) return rejected;
  return t('正在连接服务器');
}
