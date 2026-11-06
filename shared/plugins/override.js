// shared/plugins/override.js — a content plugin's `override` part (docs/PLUGINS.md §10a): a table fragment whose records
// replace fields of records the installation — or an earlier plugin of the same set — already has. It never adds a
// record (a new record belongs in `data`/`operators`/…, in the plugin's own namespace) and never deletes one: the merge
// only writes keys the fragment names, and arrays replace whole values (shared/plugins/patch.js mergeData).
//
// The content-set builder applies the parts in load order and reports every key it changed, with the chain of writers
// behind it (base → A → B): last-wins is the policy, and the report is what makes it visible
// (server/plugins/contentSet.js `overlays`, GET /mod/overlays.json). Pure data: no Node builtin, so a check that never
// runs the game reads the same rules.
import { RECORD_MAPS, forbidden, mergeData, object, own, problem } from './dataUtils.js';
import { canonicalJson } from './identity.js';

/**
 * The tables an `override` file may name: every record table with a declared id prefix (dataUtils RECORD_MAPS). The
 * entangled tables (`bonds`, `modes`, `config`, `backups`) are changed with the `data` part's patch operations, which
 * know their own rules (reconcilePluginBonds, mode inheritance …).
 */
export const OVERRIDE_TABLES = Object.freeze(Object.keys(RECORD_MAPS));
/** At most this many records in one override file. [ASSUMED] */
export const OVERRIDE_MAX_RECORDS = 2000;

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The shape of one override file: `{ "<record id>": { <field>: <value>, … }, … }`. JSON limits and prototype keys are
 * already checked when the file is read (server/plugins/contentData.js jsonProblems); here is the record granularity.
 * @param {unknown} doc the parsed file
 * @param {string} [rel] the manifest's path, for the problems
 * @returns {{ code: string, path: string, message: string }[]}
 */
export function overrideFileProblems(doc, rel = '') {
  if (!object(doc)) return [problem('PLUGIN_CONTENT_FORMAT', rel, 'an override file is { "<record id>": { … } }')];
  const out = [];
  const ids = Object.keys(doc);
  if (ids.length > OVERRIDE_MAX_RECORDS) out.push(problem('PLUGIN_DATA_LIMIT', rel, `more than ${OVERRIDE_MAX_RECORDS} records`));
  for (const id of ids.slice(0, OVERRIDE_MAX_RECORDS)) {
    if (!RECORD_ID.test(id) || forbidden(id)) out.push(problem('PLUGIN_CONTENT_FORMAT', `${rel}.${id}`, 'a record id is 1–64 letters, digits, _ or -'));
    else if (!object(doc[id])) out.push(problem('PLUGIN_CONTENT_FORMAT', `${rel}.${id}`, 'a record fragment is a JSON object'));
  }
  return out;
}

/**
 * Merge every fragment into the record `data[table][key]` it names, on a copy of that table.
 *
 * - A key the table does not have is a problem (`PLUGIN_DATA_REFERENCE`): an override replaces existing records only.
 *   That keeps the channel from adding an official-looking id (enemy_1009_slime) that no base rule would check.
 * - The result of a fragment that restates the existing value is no write at all: no copy, no conflict entry.
 * - `writes` names the keys whose value actually changed, in file order — the caller turns them into the conflict report.
 * @param {Record<string, any>} data the composed data so far
 * @param {string} table one of OVERRIDE_TABLES
 * @param {Record<string, any>} records the override file
 * @returns {{ data: Record<string, any>, problems: { code: string, path: string, message: string }[], writes: { table: string, key: string }[] }}
 */
export function applyOverrideTable(data, table, records) {
  const problems = [], writes = [];
  const before = object(data) ? data[table] : undefined;
  if (!object(before) || !OVERRIDE_TABLES.includes(table)) {
    return { data, problems: [problem('PLUGIN_CONTENT_FORMAT', table, `an override table is one of ${OVERRIDE_TABLES.join(', ')}`)], writes };
  }
  let next = before;
  for (const [key, fragment] of Object.entries(records ?? {})) {
    if (!own(next, key) || !object(next[key])) {
      problems.push(problem('PLUGIN_DATA_REFERENCE', `${table}.${key}`, 'an override replaces an existing record only; a new record belongs in the data part, in this plugin\'s namespace'));
      continue;
    }
    const merged = mergeData(next[key], fragment);
    if (canonicalJson(merged) === canonicalJson(next[key])) continue;
    if (next === before) next = { ...before };
    next[key] = merged;
    writes.push({ table, key });
  }
  return { data: next === before ? data : { ...data, [table]: next }, problems, writes };
}
