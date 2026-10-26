import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFRONT_TRAIT_GRADE } from '../../server/match/match/confrontTraits.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const enemies = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/enemies.json'), 'utf8'));

test('the trait grade table: every key is an enemy of this build', () => {
  const unknown = Object.keys(CONFRONT_TRAIT_GRADE).filter((k) => !Object.hasOwn(enemies, k));
  assert.deepEqual(unknown, [], 'a grade for an enemy this build does not have');
});

test('the trait grade table: only grades 1–3, and the documented counts', () => {
  const grades = Object.values(CONFRONT_TRAIT_GRADE);
  assert.ok(grades.length === 120, `${grades.length} entries`);
  for (const g of grades) assert.ok(g === 1 || g === 2 || g === 3, `grade ${g}`);
  const counts = grades.reduce((m, g) => ({ ...m, [g]: (m[g] || 0) + 1 }), {});
  assert.deepEqual(counts, { 1: 27, 2: 53, 3: 40 });
});

test('the trait grade table is frozen (a review is a deliberate edit)', () => {
  assert.equal(Object.isFrozen(CONFRONT_TRAIT_GRADE), true);
});
