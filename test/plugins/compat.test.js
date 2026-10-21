import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPAT_STATUS, compatSummary, packCompatibility, pluginCompatibility } from '../../shared/plugins/compat.js';

const status = (r) => r.status;
const codes = (r) => (r.reasons || []).map((x) => x.code);

test('forge pack: a declared range that covers this build is supported', () => {
  const r = packCompatibility({ gameVersion: '0.3.x' });
  assert.equal(status(r), COMPAT_STATUS.SUPPORTED);
  assert.equal(r.kind, 'forge-pack');
  assert.deepEqual(r.declared, { gameVersion: '0.3.x', game: '', api: '' });
});

test('forge pack: an older declared range is convertible, not rejected', () => {
  const r = packCompatibility({ gameVersion: '0.15.1 || 0.16.x' });
  assert.equal(status(r), COMPAT_STATUS.CONVERTIBLE);
  assert.ok(codes(r).includes('GAME_RANGE_MISMATCH'));
});

test('forge pack: `game` is read when gameVersion is absent', () => {
  const r = packCompatibility({ game: '0.2.x' });
  assert.equal(status(r), COMPAT_STATUS.CONVERTIBLE);
  assert.equal(r.declared.game, '0.2.x');
});

test('forge pack: no version declaration is unknown', () => {
  const r = packCompatibility({});
  assert.equal(status(r), COMPAT_STATUS.UNKNOWN);
  assert.ok(codes(r).includes('NO_GAME_RANGE'));
});

test('forge pack: an unreadable range is unknown', () => {
  const r = packCompatibility({ gameVersion: 'banana' });
  assert.equal(status(r), COMPAT_STATUS.UNKNOWN);
  assert.ok(codes(r).includes('BAD_GAME_RANGE'));
});

test('forge pack: a newer-only field is named when the declared range does not cover this build', () => {
  const r = packCompatibility({ game: '0.2.x', server: { modules: [{ id: 'x' }] } });
  assert.equal(status(r), COMPAT_STATUS.CONVERTIBLE);
  assert.ok(codes(r).includes('USES_NEWER_SURFACE'));
});

test('forge pack: an unmet api declaration downgrades supported to convertible', () => {
  const r = packCompatibility({ gameVersion: '0.3.x', api: '>=1 <2' });
  assert.equal(status(r), COMPAT_STATUS.CONVERTIBLE);
  assert.ok(codes(r).includes('API_RANGE_MISMATCH'));
});

test('plugin: a matching app range and api level is supported', () => {
  const r = pluginCompatibility({ app: '>=0.3.0 <0.4.0', api: 1 });
  assert.equal(status(r), COMPAT_STATUS.SUPPORTED);
  assert.equal(r.kind, 'plugin');
});

test('plugin: an app range that does not cover this build is incompatible', () => {
  const r = pluginCompatibility({ app: '>=0.4.0 <0.5.0', api: 1 });
  assert.equal(status(r), COMPAT_STATUS.INCOMPATIBLE);
  assert.ok(codes(r).includes('APP_MISMATCH'));
});

test('plugin: an api level outside this build is incompatible', () => {
  const r = pluginCompatibility({ app: '>=0.3.0 <0.4.0', api: 9 });
  assert.equal(status(r), COMPAT_STATUS.INCOMPATIBLE);
  assert.ok(codes(r).includes('API_UNSUPPORTED'));
});

test('plugin: a missing app range is unknown', () => {
  const r = pluginCompatibility({ api: 1 });
  assert.equal(status(r), COMPAT_STATUS.UNKNOWN);
  assert.ok(codes(r).includes('NO_APP_RANGE'));
});

test('plugin: a language pack without api is unknown, not incompatible', () => {
  const r = pluginCompatibility({ class: 'lang', app: '>=0.3.0 <0.4.0' });
  assert.equal(status(r), COMPAT_STATUS.UNKNOWN);
  assert.ok(codes(r).includes('NO_API_LANG'));
});

test('compatSummary names the status, target and declaration', () => {
  const r = packCompatibility({ gameVersion: '0.15.1 || 0.16.x' });
  const line = compatSummary(r);
  assert.match(line, /convertible/);
  assert.match(line, /target 0\.3\.1/);
  assert.match(line, /gameVersion=0\.15\.1 \|\| 0\.16\.x/);
});
