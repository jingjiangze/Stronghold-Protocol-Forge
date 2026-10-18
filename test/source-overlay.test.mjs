import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSourceDeltaComposition, classifyPath, conflictHunkId, featureBundlesForPath, isPathIncluded, loadSourceDeltaConfig, readGitBlob, readGitBlobs, threeWayMerge, validateCatalog, validateDecisions, validateFeatureManifest } from '../tools/source-overlay.mjs';

test('catalog pins a shared upstream baseline and two immutable sources', async () => {
  const { catalog, decisions, featureManifest } = await loadSourceDeltaConfig();
  assert.equal(catalog.upstream.baselineCommit,'cf7a9400270d5aa79b2e601e405dab782e25f120');
  assert.equal(catalog.profiles.length,2);
  assert.deepEqual(catalog.profiles.map((p)=>p.id),['stronghold-server','stronghold-server-server-agent']);
  for(const p of catalog.profiles)assert.match(p.commit,/^[0-9a-f]{40}$/);
  assert.ok(decisions.reviewRequired['stronghold-server:data/config.json']);
  assert.equal(Object.keys(decisions.pathDecisions).length,0);
  const ids = featureManifest.bundles.map((bundle) => bundle.id);
  assert.ok(ids.includes('rescue-revival'));
  assert.ok(ids.includes('unite-second-relay'));
  assert.ok(ids.includes('freeze-when-all-humans-offline'));
  assert.ok(ids.includes('host-browser-ai-rehearsal'));
  const rehearsal = featureManifest.bundles.find((bundle) => bundle.id === 'host-browser-ai-rehearsal');
  assert.ok(rehearsal.sourcePaths.includes('public/js/battle/rehearsalWorker.js'));
  assert.ok(rehearsal.sourcePaths.includes('server/sim/rehearsal.js'));
  assert.ok(rehearsal.referencePaths.includes('public/js/main.js'));
  assert.equal(decisions.reviewRequired['stronghold-server:server/match/match/settle.js'], undefined);
  assert.equal(decisions.reviewRequired['stronghold-server-server-agent:server/match/match/prep.js'], undefined);
});
test('catalog rejects a branch name instead of a fixed SHA',()=>{
  assert.throws(()=>validateCatalog({schemaVersion:1,upstream:{repository:'https://github.com/example/game.git',baselineCommit:'a'.repeat(40),auditedTargetCommit:'b'.repeat(40),targetRef:'master'},profiles:[{id:'x',repository:'https://github.com/example/source.git',ref:'master',commit:'master',sourceVersion:'1.0.0',groups:['runtime']}]}),/Invalid repository or fixed commit/);
});
test('decision validator rejects unrecognized choices',()=>{
  const ok={schemaVersion:1,pathDecisions:{'x:data/config.json':'upstream'},hunkDecisions:{},reviewRequired:{}};
  assert.equal(validateDecisions(ok).pathDecisions['x:data/config.json'],'upstream');
  assert.throws(()=>validateDecisions({...ok,pathDecisions:{'x:data/config.json':'guess'}}),/Invalid path choice/);
});
test('path classifier keeps runtime, deploy, docs and tests distinct',()=>{
  assert.equal(classifyPath('server/lobby.js'),'runtime');
  assert.equal(classifyPath('public/js/ui/matchmaking.js'),'runtime');
  assert.equal(classifyPath('deploy/stardust/compose.yaml'),'deployment');
  assert.equal(classifyPath('test/lobby.test.js'),'tests');
  assert.equal(classifyPath('docs/CONFLICTS.md'),'docs');
  assert.equal(isPathIncluded('server/lobby.js',['runtime']),true);
  assert.equal(isPathIncluded('docs/CONFLICTS.md',['runtime']),false);
});
test('hunk IDs are repeatable and content-bound',()=>{
  const id=conflictHunkId('stronghold-server','server/lobby.js','upstream line','source line');
  assert.match(id,/^h_[0-9a-f]{16}$/);
  assert.equal(id,conflictHunkId('stronghold-server','server/lobby.js','upstream line','source line'));
  assert.notEqual(id,conflictHunkId('stronghold-server','server/lobby.js','new upstream line','source line'));
});
test('three-way merge preserves non-overlapping changes',async(t)=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'source-overlay-test-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const base=Buffer.from('alpha\ncommon\nomega\n');
  const upstream=Buffer.from('alpha\ncommon\nupstream-line\nomega\n');
  const source=Buffer.from('alpha\nsource-line\ncommon\nomega\n');
  const result=await threeWayMerge(home,'sample.js',base,upstream,source);
  assert.equal(result.kind,'clean');assert.match(result.content,/source-line/);assert.match(result.content,/upstream-line/);
});
test('three-way merge reports same-hunk conflicts and does not choose a side',async(t)=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'source-overlay-test-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const base=Buffer.from('alpha\nold-value\nomega\n');
  const upstream=Buffer.from('alpha\nupstream-value\nomega\n');
  const source=Buffer.from('alpha\nsource-value\nomega\n');
  const result=await threeWayMerge(home,'sample.js',base,upstream,source);
  assert.equal(result.kind,'conflict');assert.equal(result.blocks.length,1);
  assert.equal(result.blocks[0].upstream,'upstream-value');assert.equal(result.blocks[0].source,'source-value');
});

test('source comparison reads raw Git blob bytes rather than working-tree EOL conversion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-overlay-blob-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runGit = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  runGit(['init', '--quiet']);
  runGit(['config', 'user.email', 'source-overlay-test@example.invalid']);
  runGit(['config', 'user.name', 'Source Overlay Test']);
  await fs.writeFile(path.join(root, '.gitattributes'), '*.txt text eol=crlf\n');
  await fs.writeFile(path.join(root, 'sample.txt'), 'alpha\nbeta\n');
  runGit(['add', '.gitattributes', 'sample.txt']);
  runGit(['commit', '-m', 'fixture']);
  const sha = runGit(['rev-parse', 'HEAD:sample.txt']).toString('utf8').trim();
  const rawBlob = readGitBlob(root, { mode: '100644', blob: sha });
  const batchedBlob = readGitBlobs(root, [{ mode: '100644', blob: sha }]).get(sha);
  assert.deepEqual(batchedBlob, rawBlob, 'batch read returns the same raw Git blob bytes');
  // Simulate the CRLF checkout bytes enforced by the attribute, while the Git blob stays LF-normalized.
  await fs.writeFile(path.join(root, 'sample.txt'), Buffer.from('alpha\r\nbeta\r\n', 'utf8'));
  const workingFile = await fs.readFile(path.join(root, 'sample.txt'));
  assert.deepEqual(rawBlob, Buffer.from('alpha\nbeta\n'));
  assert.deepEqual(workingFile, Buffer.from('alpha\r\nbeta\r\n'));
  assert.notDeepEqual(workingFile, rawBlob, 'eol=crlf changes the checked-out bytes, not the committed Git blob');
});


test('feature manifest treats mode paths as independent bundles and rejects unsafe paths', async () => {
  const { featureManifest } = await loadSourceDeltaConfig();
  assert.deepEqual(featureBundlesForPath(featureManifest, 'stronghold-server', 'server/match/unite.js').map((b) => b.id), ['unite-second-relay']);
  assert.ok(featureBundlesForPath(featureManifest, 'stronghold-server', 'server/match/match/combat.js').some((b) => b.id === 'rescue-revival'));
  assert.deepEqual(featureBundlesForPath(featureManifest, 'stronghold-server-server-agent', 'server/lobby.js').map((b) => b.id).sort(), ['freeze-when-all-humans-offline', 'host-browser-ai-rehearsal']);
  assert.throws(() => validateFeatureManifest({ schemaVersion: 1, bundles: [{
    id: 'unsafe', profile: 'stronghold-server', name: 'unsafe', sourcePaths: ['../outside.js'],
    integrationPoints: [], activationStatus: 'adapter-required'
  }] }), /Invalid sourcePaths/);
});

test('independent feature source is staged exactly and does not overwrite upstream shared path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'source-overlay-feature-compose-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runGit = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  async function repo(name, files) {
    const cwd = path.join(root, name);
    await fs.mkdir(cwd, { recursive: true });
    runGit(cwd, ['init', '--quiet']);
    runGit(cwd, ['config', 'user.email', 'source-overlay-test@example.invalid']);
    runGit(cwd, ['config', 'user.name', 'Source Overlay Test']);
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(cwd, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
    }
    runGit(cwd, ['add', '-A']);
    runGit(cwd, ['commit', '--quiet', '-m', 'fixture']);
    return { root: cwd, sha: runGit(cwd, ['rev-parse', 'HEAD']).toString('utf8').trim() };
  }
  const rel = 'server/match/match/settle.js';
  const baseline = await repo('baseline', { [rel]: 'baseline\n' });
  const target = await repo('target', { [rel]: 'upstream-version\n' });
  const source = await repo('source', { [rel]: 'source-mode-version\n' });
  const managerRoot = path.join(root, 'manager');
  await fs.mkdir(managerRoot);
  const outDir = path.join(root, 'composed');
  const profile = {
    id: 'stronghold-server', name: 'fixture', repository: 'https://github.com/example/source.git',
    ref: 'fixture', commit: source.sha, sourceVersion: 'test', groups: ['runtime']
  };
  const bundle = {
    id: 'rescue-revival', profile: 'stronghold-server', name: 'rescue/revival',
    sourcePaths: [rel], integrationPoints: [rel], activationStatus: 'adapter-required',
    rationale: 'adapter intentionally not implemented in this fixture'
  };
  const report = await buildSourceDeltaComposition({
    catalog: { upstream: { baselineCommit: baseline.sha, auditedTargetCommit: target.sha, targetRef: 'fixture' }, profiles: [profile] },
    decisions: { pathDecisions: {}, hunkDecisions: {}, reviewRequired: {} },
    featureManifest: { schemaVersion: 1, policy: 'test', bundles: [bundle] },
    snapshots: { base: baseline.root, target: target.root, profiles: { 'stronghold-server': source.root } },
    outDir, groups: ['runtime'], home: path.join(root, 'home'), force: false, auditOnly: false, managerRoot
  });
  assert.equal(await fs.readFile(path.join(outDir, rel), 'utf8'), 'upstream-version\n');
  assert.equal(await fs.readFile(path.join(outDir, '.forge-source-features/rescue-revival/stronghold-server/' + rel), 'utf8'), 'source-mode-version\n');
  assert.equal(report.pending.length, 0, 'feature logic is not a path-level source/upstream conflict');
  assert.equal(report.integrationPending.length, 1, 'runtime hook still needs a separate adapter');
  assert.equal(report.ready, false, 'unwired gameplay bundle must never claim READY');
});
