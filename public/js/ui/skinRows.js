// public/js/ui/skinRows.js — the picker's rows for one operator, as data (no store, no asset loading).
//
// Two manifest shapes reach the same list:
//   * `chars[<charId>].skins[<skinKey>]` — an operator's own record (docs/SKINS.md, the installation's shape);
//   * `skins[<skinId>] = { charId, name, brand, … }` — a content pack's flat catalogue (the 魔塔 package's
//     assets.json), where the operator is named by `charId` instead of by nesting.
// A flat entry whose id an operator record also writes is the same skin: the record wins (it is the installation's own
// form) and the duplicate is dropped.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);

/** Whether a skin record names a Spine model the renderer can wear (the relaxed form; see ui/skins.js). */
export const skinHasModel = (skin) => !!skin && isObj(skin.spine) && isObj(skin.spine.front) && typeof skin.spine.front.skel === 'string';

/**
 * @param {any} rec the operator's record `chars[<charId>]` (may be null: only flat entries then)
 * @param {any} flat the manifest's `skins` table (may be null)
 * @param {string} charId
 * @returns {{ id: string, name: string, group: string, playable: boolean, portrait: string|null, avatar: string|null,
 *   illust: string|null, fallbackArt: boolean, own: boolean }[]}
 */
export function skinRows(rec, flat, charId) {
  const id = str(charId);
  if (!id) return [];
  const record = isObj(rec) ? rec : null;
  const ownIllust = record ? str(record.illust) : null;
  const ownPortrait = record ? str(record.portrait) : null;
  const ownAvatar = record ? str(record.avatar) : null;
  // nothing to show: no record and no flat entry for this operator
  const nested = record && isObj(record.skins) ? record.skins : null;
  const flatOf = (() => {
    if (!isObj(flat)) return [];
    const out = [];
    for (const [skinId, skin] of Object.entries(flat)) {
      if (str(skinId) && isObj(skin) && keyOf(skin) === id) out.push([skinId, skin]);
    }
    return out;
  })();
  if (!record && !flatOf.length) return [];
  const rows = [];
  const seen = new Set();
  const push = (skinId, skin) => {
    if (!str(skinId) || !isObj(skin) || seen.has(skinId)) return;
    seen.add(skinId);
    const playable = skinHasModel(skin);
    // the tile art: the fixed-size portrait family first (a 1:2 box the grid lines up on), then the illustration, then
    // the avatar; the operator's own portrait when the skin ships none
    const ownArt = str(skin.portrait) || str(skin.illust);
    const portrait = ownArt || ownPortrait;
    const avatar = str(skin.avatar) || str(skin.illust) || ownAvatar;
    const illust = str(skin.illust) || portrait;
    rows.push({
      id: skinId,
      name: str(skin.name) || skinId,
      // `group` is the installation's field; a content pack writes `brand` (and sometimes `series`)
      group: str(skin.group) || str(skin.brand) || str(skin.series) || '',
      playable,
      portrait,
      avatar,
      illust,
      fallbackArt: !ownArt && !str(skin.avatar),
      own: false,
    });
  };
  for (const [skinId, skin] of Object.entries(nested || {})) push(skinId, skin);
  for (const [skinId, skin] of flatOf) push(skinId, skin);
  // the operator's OWN appearance, always first (ui/skins.js documents why it is never null while the record has art)
  rows.unshift({
    id: '', name: '', group: '', playable: true,
    portrait: ownIllust || ownPortrait, avatar: ownAvatar,
    illust: ownIllust || ownPortrait, fallbackArt: false, own: true,
  });
  return rows;
}

/** The operator a flat entry belongs to: `charId` (the content's field); a record nested the other way has none. */
function keyOf(skin) {
  return str(skin.charId);
}
