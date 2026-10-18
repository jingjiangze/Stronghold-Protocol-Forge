// public/js/ui/chatModel.js — the room chat's client half, as data: the line list and its rules.
//
// The server (server/lobby.js sayInRoom) is the authority for trimming, length and rate; this keeps the last 40 lines
// for display and drops them when the room changes. Nothing is persisted: a rejoining player starts empty, like a
// player who joined later (there is no history).

export const CHAT_MAX_LINES = 40;

/**
 * Add one `room.chat` frame to the list. A frame from another room replaces the list (the player moved).
 * @param {{ code: string | null, lines: any[] }} state
 * @param {any} msg the room.chat frame: { playerId, name, text, spectator, seat, at }
 * @param {{ code: string | null, max?: number }} opts
 */
export function appendChat(state, msg, { code, max = CHAT_MAX_LINES }) {
  if (!msg || typeof msg.text !== 'string' || !msg.text) return state;
  const base = state && state.code === code ? (Array.isArray(state.lines) ? state.lines : []) : [];
  const line = {
    playerId: typeof msg.playerId === 'string' ? msg.playerId : '',
    name: typeof msg.name === 'string' ? msg.name.slice(0, 24) : '',
    text: msg.text.slice(0, 80),
    spectator: msg.spectator === true,
    seat: Number.isInteger(msg.seat) ? msg.seat : null,
    at: Number.isFinite(msg.at) ? msg.at : 0,
  };
  return { code, lines: [...base, line].slice(-max) };
}

/** A room change starts an empty list (no history across rooms). */
export function chatState(code) {
  return { code: code || null, lines: [] };
}
