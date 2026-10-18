// test/ui/conn-p2p.test.js — the handshake platform's client form (server/platform.js): the URL flags a page carries
// and the two rules they change (a blip is a badge, and the wording never blames the game server).
// It imports ui/connLogic.js only — that module deliberately has no preact/htm, so this runs without the vendored
// browser libraries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P2P_BADGE_AFTER, bannerText, bannerVisible, parseRelayParam } from '../../public/js/ui/connLogic.js';

test('parseRelayParam: only an explicit p2p flag makes a platform page', () => {
  assert.deepEqual(parseRelayParam(''), { p2p: false, fallback: false, retry: false });
  assert.deepEqual(parseRelayParam('?room=AB12'), { p2p: false, fallback: false, retry: false });
  assert.deepEqual(parseRelayParam('?room=AB12&p2p=1'), { p2p: true, fallback: false, retry: false });
  // the platform's own extras only mean something on a p2p page
  assert.deepEqual(parseRelayParam('?p2p=1&o2pfallback=1'), { p2p: true, fallback: true, retry: false });
  assert.deepEqual(parseRelayParam('?p2p=1&o2pretry=1'), { p2p: true, fallback: false, retry: true });
  assert.deepEqual(parseRelayParam('?o2pfallback=1'), { p2p: false, fallback: false, retry: false });
  assert.deepEqual(parseRelayParam('?p2p=true'), { p2p: true, fallback: false, retry: false });
  assert.deepEqual(parseRelayParam('?p2p=0'), { p2p: false, fallback: false, retry: false });
});

test('bannerVisible: a p2p tunnel blip is a badge, not a banner; the banner returns after N attempts', () => {
  const reconnecting = (attempt) => ({ status: 'reconnecting', everOnline: true, attempt });
  assert.equal(bannerVisible(reconnecting(1), true, false, false, true), false, 'first attempts stay a badge');
  assert.equal(bannerVisible(reconnecting(P2P_BADGE_AFTER - 1), true, false, false, true), false);
  assert.equal(bannerVisible(reconnecting(P2P_BADGE_AFTER), true, false, false, true), true, 'from here the banner is back');
  // a direct page is unchanged
  assert.equal(bannerVisible(reconnecting(1), true, false, false, false), true);
  assert.equal(bannerVisible(reconnecting(1), true, false, false), true);
  // not entered / online keep their original answers, with and without p2p
  assert.equal(bannerVisible(reconnecting(1), false, false, false, true), false);
  assert.equal(bannerVisible({ status: 'online' }, true, false, false, true), false);
  assert.equal(bannerVisible({ status: 'online' }, true, true, false, true), true);
  // a first connection that never landed is still quiet in both modes
  assert.equal(bannerVisible({ status: 'connecting', everOnline: false }, true, false, false, true), false);
});

test('bannerText: a p2p page never says the server dropped, and names the host after N attempts', () => {
  assert.equal(bannerText({ status: 'reconnecting', attempt: 1 }, { p2p: true }), '正在连接房主…');
  assert.equal(bannerText({ status: 'reconnecting', attempt: P2P_BADGE_AFTER }, { p2p: true }), '房主可能已离线，正在重试');
  // the direct wording is untouched
  assert.equal(bannerText({ status: 'reconnecting', attempt: 1 }), '与服务器的连接已中断，正在重连');
  assert.equal(bannerText({ status: 'reconnecting', attempt: 9 }, { p2p: false }), '与服务器的连接已中断，正在重连');
  // the other states are the same in both forms
  assert.equal(bannerText({ status: 'closed' }, { replaced: true }), '该身份已在其他页面登录');
  assert.equal(bannerText({ status: 'closed' }), '连接已关闭');
  assert.equal(bannerText({ status: 'connected' }, { rejected: '房主已满' }), '房主已满');
  assert.equal(bannerText({ status: 'connecting' }), '正在连接服务器');
});
