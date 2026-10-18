// public/js/ui/chat.js — the room chat panel (room.chat). The server owns every rule (trim, 80 characters, one line a
// second, who may speak); this file only shows the last 40 lines and sends the player's line.
import { useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { store, useStore } from '../store.js';
import { net } from '../net.js';
import { appendChat, chatState } from './chatModel.js';
import { t } from '../../../shared/i18n.js';

/**
 * Follow `room.chat` into the store, and start an empty list when the room changes (there is no history across rooms,
 * and a later joiner sees only what is said after it arrived). Call once at boot.
 */
export function installChatSync() {
  net.on('room.chat', (msg) => {
    const s = store.get();
    const code = s.room && s.room.code ? s.room.code : null;
    store.patch('ui', { chat: appendChat(s.ui.chat, msg, { code }) });
  });
  net.on('room.state', (state) => {
    const code = state && typeof state.code === 'string' ? state.code : null;
    const cur = store.get().ui.chat;
    if (!cur || cur.code !== code) store.patch('ui', { chat: chatState(code) });
  });
}

export function ChatPanel() {
  const chat = useStore((s) => s.ui.chat);
  const room = useStore((s) => s.room);
  const [text, setText] = useState('');
  const code = room && room.code ? room.code : null;
  const lines = chat && chat.code === code && Array.isArray(chat.lines) ? chat.lines : [];
  const send = (e) => {
    e.preventDefault();
    const v = text.trim();
    if (!v) return;
    if (net.send('room.chat', { text: v })) setText('');
  };
  return html`<section class="room-chat" aria-label=${t('房间聊天')}>
    <div class="room-chat__log" role="log" aria-live="polite">
      ${lines.length
        ? lines.map((l, i) => html`<div class="room-chat__line" key=${i}>
            <b class=${l.spectator ? 'room-chat__who is-spec' : 'room-chat__who'}>${l.name}${l.spectator ? t('（观战）') : ''}</b>
            <span>${l.text}</span>
          </div>`)
        : html`<p class="room-chat__empty t-dim">${t('房间频道 · 只有房间里的人看得到')}</p>`}
    </div>
    <form class="room-chat__form" onSubmit=${send}>
      <input class="room-chat__input" value=${text} maxLength=${80} placeholder=${t('说点什么…')}
        aria-label=${t('聊天内容')} onInput=${(e) => setText(e.currentTarget.value)} />
      <button class="btn btn--sm" type="submit" disabled=${!text.trim()}>${t('发送')}</button>
    </form>
  </section>`;
}
