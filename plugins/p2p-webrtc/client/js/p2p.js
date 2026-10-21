// p2p-webrtc — a browser-to-browser channel for one room, with a hard fallback to the WebSocket transport.
//
// Phase 1 (this file): signaling. Offers/answers/ICE travel over the existing /ws as `p2p.*` frames; the server only
// relays them inside the room (server/lobby.js relayP2P) and never parses them.
// Phase 2: `connect(peerId)` opens an RTCPeerConnection with one ordered DataChannel. If it is not open within
// FALLBACK_MS the caller keeps using WS — nothing here can ever block the game. `sync(peerIds)` follows the room's
// seat list (bounded mesh), `broadcast(data)` fans one app frame out to the open channels.
//
// Browser-native only: no service is installed on the player's machine, and no authoritative frame (hello / room.* /
// g.* / m.*) ever travels here — a DataChannel ends at a peer browser, not at the server.
//
// It is inert until something calls `__spP2P.connect(peerId)` or the room's content set names the plugin
// (net.js follows room.state.seats[] then). `?p2p=1` forces it on, `?p2p=0` off.
const FALLBACK_MS = 3000;
const RETRY_MS = 10_000;
const MAX_PEERS = 8;
/** Incoming app frames are small by design (an emote is ~40 bytes); a peer cannot use the channel as bulk transport. */
const MAX_FRAME_CHARS = 8192;

/**
 * ICE servers: one public STUN by default, plus whatever the deployment supplies —
 * `globalThis.__SP_ICE__ = ['turn:host:3478', { urls, username, credential }]` or `?turn=turn:host:3478&turnUser=…&turnPass=…`.
 * A TURN server is optional: without one, symmetric NAT falls back to the WebSocket (never blocks the game).
 */
function iceServers() {
  const out = [{ urls: 'stun:stun.cloudflare.com:3478' }];
  const ok = (u) => typeof u === 'string' && /^(stuns?|turns?):/i.test(u);
  try {
    const forced = globalThis.__SP_ICE__;
    for (const entry of Array.isArray(forced) ? forced : []) {
      if (typeof entry === 'string') { if (ok(entry)) out.push({ urls: entry }); continue; }
      if (entry && typeof entry === 'object' && ok(entry.urls)) out.push(entry);
    }
  } catch { /* no forced list */ }
  try {
    const q = new URLSearchParams((globalThis.location && globalThis.location.search) || '');
    const turn = q.get('turn');
    if (turn) {
      const username = q.get('turnUser') || undefined;
      const credential = q.get('turnPass') || undefined;
      for (const u of turn.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (ok(u)) out.push({ urls: u, ...(username ? { username, credential } : {}) });
      }
    }
  } catch { /* no location */ }
  return out;
}
const ICE = iceServers();

const peers = new Map();   // peerId -> { pc, channel, state }
let net = null;
let selfId = null;
let onFrame = () => {};

const status = () => Object.fromEntries([...peers].map(([id, p]) => [id, p.state]));

function ensure(peerId) {
  const hit = peers.get(peerId);
  if (hit) return hit;
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const entry = { pc, channel: null, state: 'new', startedAt: Date.now() };
  peers.set(peerId, entry);
  pc.onicecandidate = (e) => { if (e.candidate && net) net.send('p2p.ice', { to: peerId, candidate: e.candidate.toJSON ? e.candidate.toJSON() : null }); };
  pc.onconnectionstatechange = () => { entry.state = pc.connectionState; };
  return entry;
}

function bindChannel(peerId, entry, channel) {
  entry.channel = channel;
  channel.binaryType = 'arraybuffer';
  channel.onopen = () => { entry.state = 'open'; };
  channel.onclose = () => { entry.state = 'closed'; };
  channel.onmessage = (e) => {
    let data = e.data;
    if (typeof data === 'string') {
      if (data.length > MAX_FRAME_CHARS) return;   // small app frames only; never bulk transport
      try { data = JSON.parse(data); } catch { /* keep the string */ }
    }
    try { onFrame(peerId, data); } catch { /* a bad frame is the caller's problem */ }
  };
}

/** Start a connection to one peer. Returns a promise that resolves true when the channel is open, false on fallback. */
export async function connect(peerId) {
  const entry = ensure(peerId);
  if (entry.channel && entry.state === 'open') return true;
  // The room state arrives repeatedly: never create a second channel for the same peer.
  if (entry.channel && entry.state !== 'failed' && entry.state !== 'closed') {
    if (Date.now() - entry.startedAt < RETRY_MS) return false;
    try { entry.pc.close(); } catch { /* already closed */ }
    peers.delete(peerId);
    return connect(peerId);
  }
  entry.startedAt = Date.now();
  bindChannel(peerId, entry, entry.pc.createDataChannel('game', { ordered: true }));
  const offer = await entry.pc.createOffer();
  await entry.pc.setLocalDescription(offer);
  net?.send('p2p.offer', { to: peerId, sdp: JSON.stringify(entry.pc.localDescription) });
  const deadline = Date.now() + FALLBACK_MS;
  while (Date.now() < deadline) {
    if (entry.state === 'open') return true;
    if (entry.state === 'failed' || entry.state === 'closed') return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return entry.state === 'open';
}

/** Keep the peer set in sync with the room: connect the new ones, drop the ones that left. */
export function sync(peerIds = []) {
  const want = new Set((Array.isArray(peerIds) ? peerIds : []).filter((id) => typeof id === 'string' && id && id !== selfId));
  for (const [id, entry] of peers) {
    if (want.has(id)) continue;
    try { entry.pc.close(); } catch { /* already closed */ }
    peers.delete(id);
    net?.send('p2p.bye', { to: id });
  }
  // A full mesh does not scale: above MAX_PEERS the extra peers keep the (authoritative) WS path and
  // still see every server-broadcast event. The cap keeps the side channel cheap.
  let connected = 0;
  for (const id of want) {
    if (connected >= MAX_PEERS) break;
    const entry = peers.get(id);
    if (entry && entry.state === 'open') { connected += 1; continue; }
    connect(id).catch(() => { /* the WS path is untouched */ });
    connected += 1;
  }
  return Math.min(want.size, MAX_PEERS);
}

/** Fan one app frame out to every open channel. Returns how many peers got it (0 = caller keeps WS). */
export function broadcast(data) {
  let payload;
  try { payload = JSON.stringify(data); } catch { return 0; }
  let sent = 0;
  for (const entry of peers.values()) {
    if (!entry.channel || entry.state !== 'open') continue;
    try { entry.channel.send(payload); sent += 1; } catch { /* that peer keeps WS */ }
  }
  return sent;
}

/** Handle one `p2p.*` frame from the server. */
export async function ingest(msg) {
  const peerId = msg.from;
  if (!peerId) return;
  if (msg.t === 'p2p.offer') {
    const entry = ensure(peerId);
    entry.pc.ondatachannel = (e) => bindChannel(peerId, entry, e.channel);
    await entry.pc.setRemoteDescription(JSON.parse(msg.sdp));
    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    net?.send('p2p.answer', { to: peerId, sdp: JSON.stringify(entry.pc.localDescription) });
  } else if (msg.t === 'p2p.answer') {
    const entry = peers.get(peerId);
    if (entry) await entry.pc.setRemoteDescription(JSON.parse(msg.sdp));
  } else if (msg.t === 'p2p.ice') {
    const entry = peers.get(peerId);
    if (entry && msg.candidate) { try { await entry.pc.addIceCandidate(msg.candidate); } catch { /* late ICE */ } }
  } else if (msg.t === 'p2p.bye') {
    const entry = peers.get(peerId);
    if (entry) { try { entry.pc.close(); } catch { /* already closed */ } peers.delete(peerId); }
  }
}

/** Send one frame over the peer's channel; false when no channel is open (the caller should use WS). */
export function send(peerId, data) {
  const entry = peers.get(peerId);
  if (!entry || !entry.channel || entry.state !== 'open') return false;
  try { entry.channel.send(data); return true; } catch { return false; }
}

export function closeAll() {
  for (const [id, e] of peers) { try { e.pc.close(); } catch { /* ignore */ } peers.delete(id); }
}

/** Wire the module to a room. `sendFrame` is net.send, `subscribe` receives every p2p.* frame. */
export function install({ net: n, self, onMessage = () => {} } = {}) {
  net = n; selfId = self || null; onFrame = onMessage;
  globalThis.__spP2P = { connect, ingest, send, sync, broadcast, closeAll, status, FALLBACK_MS };
  return globalThis.__spP2P;
}

export default { connect, ingest, send, sync, broadcast, closeAll, install, status };
