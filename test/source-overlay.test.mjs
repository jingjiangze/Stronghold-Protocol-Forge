import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyPath, conflictHunkId, isPathIncluded, loadSourceDeltaConfig, readGitBlob, threeWayMerge, validateCatalog, validateDecisions } from '../tools/source-overlay.mjs';

test('catalog pins a shared upstream baseline and two immutable sources', async () => {
  const { catalog, decisions } = await loadSourceDeltaConfig();
  assert.equal(catalog.upstream.baselineCommit,'cf7a9400270d5aa79b2e601e405dab782e25f120');
  assert.equal(catalog.profiles.length,2);
  assert.deepEqual(catalog.profiles.map((p)=>p.id),['stronghold-server','stronghold-server-server-agent']);
  for(const p of catalog.profiles)assert.match(p.commit,/^[0-9a-f]{40}$/);
  assert.ok(decisions.reviewRequired['stronghold-server:data/config.json']);
  assert.equal(Object.keys(decisions.pathDecisions).length,0);
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
  // Simulate the CRLF checkout bytes enforced by the attribute, while the Git blob stays LF-normalized.
  await fs.writeFile(path.join(root, 'sample.txt'), Buffer.from('alpha\\r\\nbeta\\r\\n', 'utf8'));
  const workingFile = await fs.readFile(path.join(root, 'sample.txt'));
  assert.deepEqual(rawBlob, Buffer.from('alpha\nbeta\n'));
  assert.notDeepEqual(workingFile, rawBlob, 'eol=crlf changes the checked-out bytes, not the committed Git blob');
});
