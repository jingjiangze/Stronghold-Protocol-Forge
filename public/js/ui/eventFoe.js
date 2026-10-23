// eventFoe.js — the monster-entry presentation the 悬赏名单 / 投放公示 rows borrow from the 事件期.
//
// The 事件期 (server/match/match/event.js) is NOT ported into this tree yet, so `m.public.event` never exists and
// `rosterFoe()` in ui/confrontOverlay.js always returns null. These four names exist so the roster code keeps ONE shape
// (and so the port of event.js can swap this file for ui/eventOverlay.js without touching the callers).
//
// Nothing here renders: it is a data shim, not a UI module.

/** Attribute key → msgid of the 强力属性 names (empty until the 事件期 lands). */
export const FOE_NAMES = Object.freeze({});

/** The effect line of a monster entry (no entries without the 事件期). */
export const foeEffect = () => '';

/** The effect line of a 强力属性 pick (same). */
export const eliteEffect = () => '';

/**
 * The card of a monster entry as the server sends it ({ key, … }), or null when this build has no 事件期.
 * @returns {null}
 */
export const eventFoeCard = () => null;
