// test/ui/chat-model.test.js — the room chat's client model: append, cap at 40, reset when the room changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_MAX_LINES, appendChat, chatState } from '../../public/js/ui/chatModel.js';

const line = (text, extra = {}) => ({ playerId: 'p1', name: 'P1', text, spectator: false, seat: 0, at: 1, ...extra });

test('a line is kept with the fields the room needs, and nothing else', () => {
  const s0 = chatState('AB12');
  const s1 = appendChat(s0, line('你好', { extra: 'ignored' }), { code: 'AB12' });
  assert.equal(s1.code, 'AB12');
  assert.deepEqual(s1.lines, [{ playerId: 'p1', name: 'P1', text: '你好', spectator: false, seat: 0, at: 1 }]);
  assert.equal('extra' in s1.lines[0], false);
});

test('the list keeps the last 40 lines', () => {
  let s = chatState('AB12');
  for (let i = 0; i < CHAT_MAX_LINES + 5; i++) s = appendChat(s, line(`m${i}`), { code: 'AB12' });
  assert.equal(s.lines.length, CHAT_MAX_LINES);
  assert.equal(s.lines[0].text, 'm5');
  assert.equal(s.lines.at(-1).text, `m${CHAT_MAX_LINES + 4}`);
});

test('a line from another room replaces the list: no history across rooms', () => {
  const s = appendChat(chatState('AB12'), line('old room'), { code: 'AB12' });
  const next = appendChat(s, line('new room'), { code: 'CD34' });
  assert.equal(next.code, 'CD34');
  assert.deepEqual(next.lines.map((l) => l.text), ['new room']);
});

test('malformed frames are dropped; fields are coerced to the wire shape', () => {
  const s0 = chatState('AB12');
  assert.equal(appendChat(s0, null, { code: 'AB12' }), s0);
  assert.equal(appendChat(s0, { text: '' }, { code: 'AB12' }), s0);
  assert.equal(appendChat(s0, { text: 42 }, { code: 'AB12' }), s0);
  const s = appendChat(s0, { text: 'x'.repeat(200), name: 'N'.repeat(40), spectator: 'yes', seat: '3', at: 'now' }, { code: 'AB12' });
  assert.equal(s.lines[0].text.length, 80, 'the server cuts to 80; the client never shows more');
  assert.equal(s.lines[0].name.length, 24);
  assert.equal(s.lines[0].spectator, false, 'only the literal true marks a spectator');
  assert.equal(s.lines[0].seat, null);
  assert.equal(s.lines[0].at, 0);
});
