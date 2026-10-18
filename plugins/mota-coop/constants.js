// 魔塔 mode module (server/mota/) — the constants the 救援 rule set needs.
// The upstream 0.3.1 shared/constants.js has no revival vocabulary, and the module keeps its additions here so the
// shared file stays upstream's.

/** 每人每次从共享池扣 costPer + step × 已复活次数（5 / 10 / 15…）。 */
export const REVIVAL_COST_PER = 5;
export const REVIVAL_COST_STEP = 5;
/** Why a downed player could not be rescued — carried on the player and shown to the room (never a raw code). */
export const REVIVAL_UNAVAILABLE_REASONS = Object.freeze(['left', 'already-used', 'disabled', 'match-ended', 'no-voter', 'pool', 'window-closed', 'window-expired']);
/** The settle window a pending rescue holds the match open for (ms). */
export const REVIVAL_WINDOW_MS = 30_000;
