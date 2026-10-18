#!/usr/bin/env node
// Compose immutable source-code deltas on an isolated upstream tree.
// Never writes to either feature-source repository or the Forge checkout.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CATALOG_URL = new URL('../config/source-delta-profiles.json', import.meta.url);
const DECISIONS_URL = new URL('../config/source-delta-decisions.json', import.meta.url);
const FEATURES_URL = new URL('../config/source-delta-features.json', import.meta.url);
const DEFAULT_GROUPS = ['runtime', 'build', 'operations', 'deployment'];
const GROUPS = ['runtime', 'build', 'operations', 'deployment', 'docs', 'tests', 'automation', 'metadata'];
const PATH_CHOICES = new Set(['source', 'upstream', 'merge']);
const HUNK_CHOICES = new Set(['source', 'upstream']);
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const validRepo = (v) => typeof v === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(v);
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const inside = (root, candidate) => {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

function safePath(input) {
  if (typeof input !== 'string' || !input || input.includes('\\')) return '';
  const rel = path.posix.normalize(input);
  if (rel === '.' || rel === '..' || rel.startsWith('../') || rel.startsWith('/')) return '';
  if (rel.split('/').some((part) => ['.git', 'node_modules', '.cache', 'coverage'].includes(part))) return '';
  return rel;
}

export function classifyPath(input) {
  const p = safePath(input);
  const base = path.posix.basename(p);
  if (!p) return 'metadata';
  if (p.startsWith('test/') || p.includes('/test/')) return 'tests';
  if (p.startsWith('docs/') || ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'NOTICE.md', 'AGENTS.md', 'CLAUDE.md'].includes(p)) return 'docs';
  if (p.startsWith('.github/')) return 'automation';
  if (p.startsWith('deploy/') || ['Dockerfile', '.dockerignore', 'docker-compose.yml', 'compose.yaml'].includes(p)) return 'deployment';
  if (p.startsWith('server/') || p.startsWith('shared/') || p.startsWith('public/') || p.startsWith('data/')) return 'runtime';
  if (p.startsWith('tools/')) return 'build';
  if (p.startsWith('scripts/')) return 'operations';
  if (['package.json', 'package-lock.json', 'eslint.config.js', 'jsconfig.json', '.gitattributes'].includes(p)) return 'build';
  if (['.gitignore', '.npmrc', '.node-version', '.nvmrc'].includes(base)) return 'operations';
  return 'metadata';
}

export function isPathIncluded(relativePath, groups) {
  return groups.includes(classifyPath(relativePath));
}

export function conflictHunkId(profileId, relativePath, upstreamText, sourceText) {
  return 'h_' + hash(Buffer.from(profileId + '\0' + relativePath + '\0'
    + String(upstreamText || '') + '\0' + String(sourceText || ''), 'utf8')).slice(0, 16);
}

export function validateCatalog(doc) {
  if (!doc || doc.schemaVersion !== 1 || !doc.upstream || !Array.isArray(doc.profiles)) throw new Error('Invalid source-delta catalog.');
  if (!validRepo(doc.upstream.repository) || !isSha(doc.upstream.baselineCommit) || !isSha(doc.upstream.auditedTargetCommit)) {
    throw new Error('Invalid upstream pins.');
  }
  const ids = new Set();
  const profiles = doc.profiles.map((p) => {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id) || ids.has(p.id)) throw new Error('Invalid or duplicate profile ID.');
    ids.add(p.id);
    if (!validRepo(p.repository) || !isSha(p.commit)) throw new Error('Invalid repository or fixed commit for ' + p.id);
    if (typeof p.ref !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(p.ref) || typeof p.sourceVersion !== 'string') throw new Error('Invalid ref/version for ' + p.id);
    if (!Array.isArray(p.groups) || p.groups.some((g) => !GROUPS.includes(g))) throw new Error('Invalid groups for ' + p.id);
    return Object.freeze({ ...p, groups: [...new Set(p.groups)] });
  });
  if (!profiles.length) throw new Error('No source profiles.');
  return { schemaVersion: 1, upstream: Object.freeze({ ...doc.upstream }), profiles: Object.freeze(profiles) };
}

export function validateDecisions(doc) {
  if (!doc || doc.schemaVersion !== 1 || !doc.pathDecisions || !doc.hunkDecisions || !doc.reviewRequired) throw new Error('Invalid decision file.');
  for (const [key, choice] of Object.entries(doc.pathDecisions)) {
    if (!key.includes(':') || !PATH_CHOICES.has(choice)) throw new Error('Invalid path choice: ' + key);
  }
  for (const [key, choice] of Object.entries(doc.hunkDecisions)) {
    if (!/^h_[0-9a-f]{16}$/.test(key) || !HUNK_CHOICES.has(choice)) throw new Error('Invalid hunk choice: ' + key);
  }
  return doc;
}

export function validateFeatureManifest(doc) {
  if (!doc || doc.schemaVersion !== 1 || !Array.isArray(doc.bundles)) throw new Error('Invalid independent-feature manifest.');
  const ids = new Set();
  const bundles = doc.bundles.map((bundle) => {
    if (!bundle || typeof bundle.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(bundle.id) || ids.has(bundle.id)) {
      throw new Error('Invalid or duplicate feature bundle ID.');
    }
    ids.add(bundle.id);
    if (typeof bundle.profile !== 'string' || typeof bundle.name !== 'string' || !bundle.name.trim()) throw new Error('Invalid feature bundle identity: ' + bundle.id);
    const sourcePaths = Array.isArray(bundle.sourcePaths) ? bundle.sourcePaths : [];
    const referencePaths = Array.isArray(bundle.referencePaths) ? bundle.referencePaths : [];
    const invalidPaths = [...sourcePaths, ...referencePaths].some((p) => !safePath(p) || safePath(p) !== p);
    if ((!sourcePaths.length && !referencePaths.length) || invalidPaths) {
      throw new Error('Invalid sourcePaths/referencePaths for feature bundle: ' + bundle.id);
    }
    if (new Set(sourcePaths).size !== sourcePaths.length || new Set(referencePaths).size !== referencePaths.length) {
      throw new Error('Duplicate source/reference path in feature bundle: ' + bundle.id);
    }
    if (!Array.isArray(bundle.integrationPoints) || bundle.integrationPoints.some((p) => !safePath(p) || safePath(p) !== p)) {
      throw new Error('Invalid integrationPoints for feature bundle: ' + bundle.id);
    }
    if (!['adapter-required', 'ready'].includes(bundle.activationStatus)) throw new Error('Invalid activationStatus for feature bundle: ' + bundle.id);
    return Object.freeze({
      ...bundle,
      sourcePaths: [...new Set(sourcePaths)],
      referencePaths: [...new Set(referencePaths)],
      integrationPoints: [...new Set(bundle.integrationPoints)],
    });
  });
  return Object.freeze({ schemaVersion: 1, policy: String(doc.policy || 'independent-feature-bundles'), bundles: Object.freeze(bundles) });
}

export function featureBundleEntriesForPath(manifest, profileId, relativePath) {
  if (!manifest || !Array.isArray(manifest.bundles)) return [];
  return manifest.bundles.flatMap((bundle) => {
    if (bundle.profile !== profileId) return [];
    const out = [];
    if (bundle.sourcePaths.includes(relativePath)) out.push({ bundle, kind: 'feature' });
    if ((bundle.referencePaths || []).includes(relativePath)) out.push({ bundle, kind: 'reference' });
    return out;
  });
}

export function featureBundlesForPath(manifest, profileId, relativePath) {
  const unique = new Map();
  for (const entry of featureBundleEntriesForPath(manifest, profileId, relativePath)) unique.set(entry.bundle.id, entry.bundle);
  return [...unique.values()];
}

export async function loadSourceDeltaConfig() {
  const catalog = validateCatalog(JSON.parse(await fs.readFile(CATALOG_URL, 'utf8')));
  const decisions = validateDecisions(JSON.parse(await fs.readFile(DECISIONS_URL, 'utf8')));
  const featureManifest = validateFeatureManifest(JSON.parse(await fs.readFile(FEATURES_URL, 'utf8')));
  const knownProfiles = new Set(catalog.profiles.map((profile) => profile.id));
  const unknownProfiles = featureManifest.bundles.filter((bundle) => !knownProfiles.has(bundle.profile));
  if (unknownProfiles.length) throw new Error('Feature manifest references unknown profile(s): ' + unknownProfiles.map((bundle) => bundle.profile).join(', '));
  return { catalog, decisions, featureManifest };
}

export function sourceOverlayHome(env = process.env, home = os.homedir()) {
  const override = typeof env.SP_SOURCE_OVERLAY_HOME === 'string' ? env.SP_SOURCE_OVERLAY_HOME.trim() : '';
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('SP_SOURCE_OVERLAY_HOME must be absolute.');
    return path.resolve(override);
  }
  return path.join(home, '.stronghold-protocol-forge', 'source-overlays');
}

function git(cwd, args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd, encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    maxBuffer: 128 * 1024 * 1024, windowsHide: true,
    stdio: opts.inherit ? 'inherit' : 'pipe', env: opts.env || process.env,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFailure) {
    const detail = String(res.stderr || res.stdout || '').trim();
    throw new Error('git ' + args.join(' ') + ' failed (' + res.status + ')' + (detail ? ': ' + detail.slice(0, 1200) : ''));
  }
  return res;
}

async function assertOutside(directory, forbidden = []) {
  const absolute = path.resolve(directory);
  for (const item of forbidden.filter(Boolean)) {
    const root = path.resolve(item);
    if (absolute === root || inside(root, absolute)) throw new Error('Cache/output must be outside repository worktrees: ' + root);
  }
  let probe = absolute;
  while (!fsSync.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const found = git(probe, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  if (found.status === 0) {
    const root = path.resolve(found.stdout.trim());
    if (absolute === root || inside(root, absolute)) throw new Error('Cache/output resolves inside Git worktree: ' + root);
  }
  // Create only the parent. Creating the target here makes compose misread its own reserved
  // output directory as a pre-existing user directory and abort before writing anything.
  await fs.mkdir(path.dirname(absolute), { recursive: true });
}

async function prepareSnapshot(home, label, repository, ref, commit) {
  const slug = repository.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/[^A-Za-z0-9_.-]+/g, '_');
  const root = path.join(home, 'snapshots', slug, commit);
  await fs.mkdir(path.dirname(root), { recursive: true });
  if (fsSync.existsSync(path.join(root, '.git'))) {
    try {
      const current = git(root, ['rev-parse', 'HEAD']).stdout.trim();
      const remote = git(root, ['remote', 'get-url', 'origin']).stdout.trim().replace(/\.git$/, '');
      if (current === commit && remote === repository.replace(/\.git$/, '')) return root;
    } catch { /* stale cache is rebuilt below */ }
    await fs.rm(root, { recursive: true, force: true });
  } else if (fsSync.existsSync(root)) await fs.rm(root, { recursive: true, force: true });
  console.log('[source-overlay] fetching ' + label + ' @ ' + commit);
  git(home, ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', '--branch', ref, repository, root], { inherit: true });
  if (git(root, ['rev-parse', 'HEAD']).stdout.trim() !== commit) {
    git(root, ['fetch', '--depth=1', 'origin', commit], { inherit: true });
    git(root, ['checkout', '--detach', commit], { inherit: true });
  }
  const actual = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  if (actual !== commit) throw new Error(label + ' SHA mismatch: expected ' + commit + ', got ' + actual);
  return root;
}

function indexTracked(root) {
  const raw = git(root, ['ls-files', '-s', '-z']).stdout;
  const out = new Map();
  for (const item of raw.split('\0')) {
    if (!item) continue;
    const tab = item.indexOf('\t');
    if (tab < 0) continue;
    const meta = item.slice(0, tab).split(' ');
    const p = safePath(item.slice(tab + 1));
    if (!p) throw new Error('Unsafe tracked path: ' + item.slice(tab + 1));
    out.set(p, { mode: meta[0] || '100644', blob: meta[1] || '' });
  }
  return out;
}

export function readGitBlob(root, entry) {
  if (!entry || !/^[0-9a-f]{40}$/.test(entry.blob || '')) throw new Error('Invalid Git blob ID.');
  if (entry.mode === '120000') return null;
  return git(root, ['cat-file', 'blob', entry.blob], { encoding: null }).stdout;
}

async function readFile(root, relativePath) {
  const rel = safePath(relativePath);
  if (!rel) throw new Error('Unsafe path: ' + relativePath);
  const absolute = path.resolve(root, ...rel.split('/'));
  if (!inside(root, absolute)) throw new Error('Path escaped root.');
  try {
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return await fs.readFile(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFile(root, relativePath, bytes, mode = '100644') {
  const rel = safePath(relativePath);
  if (!rel) throw new Error('Unsafe output path: ' + relativePath);
  const absolute = path.resolve(root, ...rel.split('/'));
  if (!inside(root, absolute)) throw new Error('Output path escaped composition root.');
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, bytes);
  if (process.platform !== 'win32') await fs.chmod(absolute, mode === '100755' ? 0o755 : 0o644).catch(() => {});
}

async function removeFile(root, relativePath) {
  const rel = safePath(relativePath);
  if (!rel) throw new Error('Unsafe delete path.');
  const absolute = path.resolve(root, ...rel.split('/'));
  if (!inside(root, absolute)) throw new Error('Delete path escaped composition root.');
  await fs.rm(absolute, { force: true });
}

function parseMergeConflicts(output) {
  const lines = String(output).split(/\r?\n/), segments = [], blocks = [];
  let normal = [], side = '', upstream = [], source = [];
  for (const line of lines) {
    if (!side && line === '<<<<<<< UPSTREAM') {
      if (normal.length) segments.push({ type: 'text', text: normal.join('\n') });
      normal = []; upstream = []; source = []; side = 'upstream';
    } else if (side === 'upstream' && line === '=======') side = 'source';
    else if (side === 'source' && line === '>>>>>>> SOURCE') {
      const block = { type: 'conflict', upstream: upstream.join('\n'), source: source.join('\n') };
      segments.push(block); blocks.push(block); side = '';
    } else if (side === 'upstream') upstream.push(line);
    else if (side === 'source') source.push(line);
    else normal.push(line);
  }
  if (side) return { segments: [], blocks: [], invalid: true };
  if (normal.length) segments.push({ type: 'text', text: normal.join('\n') });
  return { segments, blocks, invalid: false };
}

export async function threeWayMerge(home, relativePath, baseBytes, upstreamBytes, sourceBytes) {
  if (baseBytes.includes(0) || upstreamBytes.includes(0) || sourceBytes.includes(0)) return { kind: 'binary-conflict', segments: [], blocks: [] };
  const temp = await fs.mkdtemp(path.join(home, 'merge-'));
  try {
    const base = path.join(temp, 'base.txt'), upstream = path.join(temp, 'upstream.txt'), source = path.join(temp, 'source.txt');
    await Promise.all([fs.writeFile(base, baseBytes), fs.writeFile(upstream, upstreamBytes), fs.writeFile(source, sourceBytes)]);
    const res = git(temp, ['merge-file', '-p', '-L', 'UPSTREAM', '-L', 'BASE', '-L', 'SOURCE', upstream, base, source], { allowFailure: true });
    if (res.status === 0) return { kind: 'clean', content: res.stdout, segments: [], blocks: [] };
    if (res.status !== 1) throw new Error('git merge-file failed for ' + relativePath);
    const parsed = parseMergeConflicts(res.stdout);
    if (parsed.invalid || !parsed.blocks.length) return { kind: 'unparsed-conflict', segments: [], blocks: [] };
    return { kind: 'conflict', segments: parsed.segments, blocks: parsed.blocks };
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

function tags(pathValue) {
  const p = pathValue.toLowerCase(), out = [];
  if (p.includes('announcements')) out.push('大厅公告');
  if (p.includes('damageboard') || p.includes('damage-board') || p.includes('combatmetrics')) out.push('伤害统计面板');
  if (p.includes('revival') || p.endsWith('/settle.js')) out.push('救援/复活结算');
  if (p.includes('matchmaking') || p.includes('queuecancellation') || p.includes('playercapacity') || p.includes('experimental')) out.push('公共匹配与房间容量');
  if (p.includes('lineup') || p.includes('migrate-lineups')) out.push('真人布阵学习库与同步');
  if (p.includes('rehearsal')) out.push('房主浏览器代算 AI 布阵');
  if (p.includes('frozen')) out.push('全员离线时冻结对局');
  if (p.includes('healthmetrics') || p.includes('wscompression') || p.includes('traffic') || p.includes('mirrorprobe') || p.includes('upstreamwatch')) out.push('流量/性能/上游监测');
  if (p.includes('asset-jump') || p.includes('assetindex') || p.includes('assetviews') || p.includes('materialfallback') || p.includes('materialloader') || p.includes('materialimage')) out.push('素材寻址、缓存与回退');
  if (p.includes('skin') || p.includes('operatorpreset')) out.push('皮肤与干员预设 UI');
  if (p.includes('voice')) out.push('语音播放');
  if (p.includes('cluster/') || p.startsWith('deploy/')) out.push('集群/部署设施');
  if (p === 'data/config.json' || p.includes('boss')) out.push('玩法数值与首领平衡');
  if (p.endsWith('server/lobby.js') || p.includes('shared/protocol.js') || p.endsWith('server/net.js')) out.push('房间/网络协议挂载点');
  if (p.startsWith('public/')) out.push('客户端 UI/渲染');
  return [...new Set(out.length ? out : [classifyPath(pathValue)])];
}

function clip(value, max = 210) {
  if (!value) return '';
  const text = String(value).replace(/\r/g, '');
  return text.length > max ? text.slice(0, max) + ' …' : text;
}

function pending(report, profile, pathValue, kind, id, reason, upstreamText, sourceText) {
  report.pending.push({
    profile: profile.id, path: pathValue, group: classifyPath(pathValue), features: tags(pathValue),
    kind, id: id || null, reason, upstreamSnippet: clip(upstreamText), sourceSnippet: clip(sourceText),
  });
}

async function applyProfile(o) {
  const baseIndex = indexTracked(o.baseRoot), sourceIndex = indexTracked(o.sourceRoot);
  const profileBundles = (o.featureManifest?.bundles || []).filter((bundle) => bundle.profile === o.profile.id);
  for (const bundle of profileBundles) {
    for (const p of [...bundle.sourcePaths, ...(bundle.referencePaths || [])]) {
      const entry = sourceIndex.get(p);
      if (!entry || readGitBlob(o.sourceRoot, entry) === null) {
        pending(o.report, o.profile, p, 'feature-source-missing', null,
          'Feature bundle ' + bundle.id + ' references a missing or unsupported source blob; check the pinned source tree.',
          '<source path unavailable>', '<feature bundle expects this path>');
        o.summary.pending++;
      }
    }
  }
  const paths = [...new Set([...baseIndex.keys(), ...sourceIndex.keys()])].sort();
  for (const p of paths) {
    const be = baseIndex.get(p), se = sourceIndex.get(p);
    const base = be ? readGitBlob(o.baseRoot, be) : null;
    const source = se ? readGitBlob(o.sourceRoot, se) : null;
    if (se && source === null) { pending(o.report,o.profile,p,'unsafe-source-path',null,'Source path is not a regular file.','<not read>','<unsupported>'); o.summary.pending++; continue; }
    if (be && base === null) throw new Error('Cannot read baseline file: ' + p);
    if (!be && !se) continue;

    const group = classifyPath(p), row = { profile:o.profile.id, path:p, group, features:tags(p) };
    const sameToBase = !!(be && se && hash(base) === hash(source));
    const changed = !sameToBase;
    const featureBundleEntries = featureBundleEntriesForPath(o.featureManifest, o.profile.id, p);
    const featureBundleMap = new Map(featureBundleEntries.map((entry) => [entry.bundle.id, entry.bundle]));
    const featureBundles = [...featureBundleMap.values()];
    if (changed) {
      o.summary.deltaFiles++;
      o.summary.byGroup[group] = (o.summary.byGroup[group] || 0) + 1;
    }
    if (!o.groups.includes(group) || !o.profile.groups.includes(group)) {
      if (changed) { row.status='excluded-group'; o.report.omitted.push(row); o.summary.excluded++; }
      continue;
    }
    // Gameplay source is preserved byte-for-byte in a manager-owned namespace. The upstream
    // common-path file remains in the composed tree; only an explicit adapter may activate it.
    // This prevents a whole-file source/upstream choice from deciding independent mode behavior.
    if (featureBundles.length && se && source !== null) {
      const stagedPaths = [];
      for (const { bundle, kind } of featureBundleEntries) {
        const namespace = kind === 'feature' ? '.forge-source-features' : '.forge-source-references';
        const stagedPath = namespace + '/' + bundle.id + '/' + o.profile.id + '/' + p;
        await writeFile(o.outputRoot, stagedPath, source, se.mode);
        stagedPaths.push(stagedPath);
        let featureRecord = o.report.featureBundles.find((entry) => entry.id === bundle.id);
        if (!featureRecord) {
          featureRecord = {
            id: bundle.id, profile: bundle.profile, name: bundle.name,
            activationStatus: bundle.activationStatus,
            rationale: bundle.rationale || '',
            sourcePaths: bundle.sourcePaths,
            referencePaths: bundle.referencePaths || [],
            integrationPoints: bundle.integrationPoints,
            stagedFiles: [],
          };
          o.report.featureBundles.push(featureRecord);
        }
        if (!featureRecord.stagedFiles.some((entry) => entry.sourcePath === p && entry.kind === kind)) {
          featureRecord.stagedFiles.push({ kind, sourcePath: p, outputPath: stagedPath, gitBlob: se.blob });
          if (kind === 'feature') o.summary.featureSourcesStaged++;
          else o.summary.referenceSourcesStaged++;
        }
      }
      row.status = changed ? 'independent-bundle-source-staged' : 'independent-bundle-source-preserved';
      row.featureBundles = featureBundles.map((bundle) => bundle.id);
      row.stagedKinds = [...new Set(featureBundleEntries.map((entry) => entry.kind))];
      row.stagedPaths = stagedPaths;
      row.note = 'Exact source blob staged in the feature or reference namespace; upstream common-path implementation is not overwritten.';
      o.report.applied.push(row);
      continue;
    }
    if (sameToBase) continue;
    const key = o.profile.id + ':' + p, pathChoice = o.decisions.pathDecisions[key];
    if (pathChoice) o.used.add(key);
    if (Object.prototype.hasOwnProperty.call(o.decisions.reviewRequired,key) && !pathChoice) {
      pending(o.report,o.profile,p,'owner-review-required',null,o.decisions.reviewRequired[key],'<upstream retained>','<source delta held>');
      row.status='owner-review-required'; o.report.omitted.push(row); o.summary.pending++; continue;
    }
    if (pathChoice === 'upstream') { row.status='owner-chose-upstream'; o.report.applied.push(row); o.summary.upstreamChoice++; continue; }
    if (pathChoice === 'source') {
      if (source === null) await removeFile(o.outputRoot,p); else await writeFile(o.outputRoot,p,source,se.mode);
      row.status='owner-chose-source'; o.report.applied.push(row); o.summary.sourceChoice++; continue;
    }

    const current = await readFile(o.outputRoot,p);
    const bh = base === null ? null : hash(base), sh = source === null ? null : hash(source), ch = current === null ? null : hash(current);
    if (!be && se) {
      if (current === null) { await writeFile(o.outputRoot,p,source,se.mode); row.status='source-addition-mounted'; o.report.applied.push(row); o.summary.additionsMounted++; }
      else if (ch === sh) { row.status='already-present-upstream'; o.report.applied.push(row); o.summary.alreadyPresent++; }
      else {
        const id=conflictHunkId(o.profile.id,p,current.toString('utf8'),source.toString('utf8')), choice=o.decisions.hunkDecisions[id];
        if (choice) o.used.add(id);
        if (choice==='source') { await writeFile(o.outputRoot,p,source,se.mode); row.status='add-add-source-chosen'; o.report.applied.push(row); }
        else if (choice==='upstream') { row.status='add-add-upstream-chosen'; o.report.applied.push(row); }
        else { pending(o.report,o.profile,p,'add-add',id,'Same path was added with different bytes; choose source/upstream.',current.toString('utf8'),source.toString('utf8')); o.summary.pending++; }
      }
      continue;
    }
    if (be && !se) {
      if (current === null) { row.status='already-deleted-upstream'; o.report.applied.push(row); o.summary.alreadyPresent++; }
      else if (ch === bh) { await removeFile(o.outputRoot,p); row.status='source-deletion-mounted'; o.report.applied.push(row); o.summary.deletionsMounted++; }
      else {
        const id=conflictHunkId(o.profile.id,p,current.toString('utf8'),'<DELETE>'), choice=o.decisions.hunkDecisions[id];
        if (choice) o.used.add(id);
        if (choice==='source') { await removeFile(o.outputRoot,p); row.status='delete-modified-source-chosen'; o.report.applied.push(row); }
        else if (choice==='upstream') { row.status='delete-modified-upstream-chosen'; o.report.applied.push(row); }
        else { pending(o.report,o.profile,p,'delete-modified',id,'Source deletes a file changed by upstream; choose deletion/keep.',current.toString('utf8'),'<DELETE>'); o.summary.pending++; }
      }
      continue;
    }
    if (source === null || base === null) { pending(o.report,o.profile,p,'unreadable-input',null,'Changed file could not be read.','<unknown>','<unreadable>'); o.summary.pending++; continue; }
    if (current === null) {
      const id=conflictHunkId(o.profile.id,p,'<DELETE>',source.toString('utf8')), choice=o.decisions.hunkDecisions[id];
      if (choice) o.used.add(id);
      if (choice==='source') { await writeFile(o.outputRoot,p,source,se.mode); row.status='modify-deleted-source-chosen'; o.report.applied.push(row); }
      else if (choice==='upstream') { row.status='modify-deleted-upstream-chosen'; o.report.applied.push(row); }
      else { pending(o.report,o.profile,p,'modify-deleted',id,'Source modifies a baseline file deleted upstream; choose restore/keep deletion.','<DELETE>',source.toString('utf8')); o.summary.pending++; }
      continue;
    }
    if (ch === sh) { row.status='already-present-upstream'; o.report.applied.push(row); o.summary.alreadyPresent++; continue; }
    if (ch === bh) { await writeFile(o.outputRoot,p,source,se.mode); row.status='source-change-mounted'; o.report.applied.push(row); o.summary.sourceChangesMounted++; continue; }

    const merge = await threeWayMerge(o.home,p,base,current,source);
    if (merge.kind === 'clean') { await writeFile(o.outputRoot,p,merge.content,se.mode); row.status='three-way-merge-clean'; o.report.applied.push(row); o.summary.autoMerged++; continue; }
    if (merge.kind === 'conflict') {
      const conflicts=merge.blocks.map((block)=>{const id=conflictHunkId(o.profile.id,p,block.upstream,block.source);return {...block,id,choice:o.decisions.hunkDecisions[id]};});
      for (const c of conflicts) if (c.choice) o.used.add(c.id);
      let missing=0; const pieces=[];
      for (const part of merge.segments) {
        if (part.type==='text') pieces.push(part.text);
        else {
          const c=conflicts.find((item)=>item.upstream===part.upstream && item.source===part.source);
          if (c && c.choice==='source') pieces.push(c.source);
          else if (c && c.choice==='upstream') pieces.push(c.upstream);
          else { pieces.push(''); missing++; pending(o.report,o.profile,p,'three-way-hunk',c?c.id:null,'Both sides changed this hunk; choose source/upstream in hunkDecisions.',part.upstream,part.source); }
        }
      }
      if (!missing) { await writeFile(o.outputRoot,p,pieces.join('\n'),se.mode); row.status='three-way-hunk-decisions-applied'; o.report.applied.push(row); o.summary.hunkChoicesApplied+=conflicts.length; }
      else { row.status='pending-three-way-conflict'; o.report.omitted.push(row); o.summary.pending+=missing; }
      continue;
    }
    const id=conflictHunkId(o.profile.id,p,current.toString('utf8'),source.toString('utf8')), choice=o.decisions.hunkDecisions[id];
    if (choice) o.used.add(id);
    if (choice==='source') { await writeFile(o.outputRoot,p,source,se.mode); row.status='binary-conflict-source-chosen'; o.report.applied.push(row); }
    else if (choice==='upstream') { row.status='binary-conflict-upstream-chosen'; o.report.applied.push(row); }
    else { pending(o.report,o.profile,p,merge.kind,id,'Binary/unparsed conflict; choose source/upstream.','<binary/current>','<binary/source>'); o.summary.pending++; }
  }
}

async function copyTarget(targetRoot, outRoot) {
  const index=indexTracked(targetRoot);
  for (const [p,entry] of index) {
    if (entry.mode==='120000') throw new Error('Unsupported symlink in upstream tree: '+p);
    const bytes=readGitBlob(targetRoot,entry);
    if (bytes===null) throw new Error('Cannot read upstream file: '+p);
    await writeFile(outRoot,p,bytes,entry.mode);
  }
  return index.size;
}

function profileSummary(profile) {
  return {id:profile.id,commit:profile.commit,sourceVersion:profile.sourceVersion,deltaFiles:0,excluded:0,
    additionsMounted:0,deletionsMounted:0,sourceChangesMounted:0,autoMerged:0,alreadyPresent:0,
    sourceChoice:0,upstreamChoice:0,hunkChoicesApplied:0,featureSourcesStaged:0,referenceSourcesStaged:0,pending:0,byGroup:{}};
}

export async function buildSourceDeltaComposition(o) {
  const outputPath=path.resolve(o.outDir);
  if (!o.auditOnly) await assertOutside(outputPath,[o.managerRoot,o.snapshots.base,o.snapshots.target,...Object.values(o.snapshots.profiles)]);
  if (!o.auditOnly && fsSync.existsSync(outputPath)) {
    if (!o.force) throw new Error('Output exists; pass --force to replace it: '+outputPath);
    await fs.rm(outputPath,{recursive:true,force:true});
  }
  const root=o.auditOnly ? await fs.mkdtemp(path.join(o.home,'audit-output-')) : outputPath;
  await fs.mkdir(root,{recursive:true});
  const report={schemaVersion:2,baseCommit:o.catalog.upstream.baselineCommit,upstreamCommit:o.catalog.upstream.auditedTargetCommit,
    targetRef:o.catalog.upstream.targetRef,output:o.auditOnly?null:outputPath,includedGroups:o.groups,upstreamFiles:await copyTarget(o.snapshots.target,root),
    ready:false,profiles:[],pending:[],featureBundles:[],integrationPending:[],omitted:[],applied:[],staleDecisions:[]};
  const used=new Set();
  for (const profile of o.catalog.profiles) {
    const summary=profileSummary(profile);
    await applyProfile({profile,baseRoot:o.snapshots.base,sourceRoot:o.snapshots.profiles[profile.id],outputRoot:root,
      groups:o.groups,decisions:o.decisions,featureManifest:o.featureManifest,home:o.home,report,summary,used});
    report.profiles.push(summary);
  }
  report.staleDecisions=[...new Set([...Object.keys(o.decisions.pathDecisions),...Object.keys(o.decisions.hunkDecisions)])].filter((key)=>!used.has(key));
  report.integrationPending=report.featureBundles.filter((bundle)=>bundle.activationStatus!=='ready').map((bundle)=>({
    id:bundle.id,profile:bundle.profile,name:bundle.name,status:bundle.activationStatus,
    integrationPoints:bundle.integrationPoints,stagedFiles:bundle.stagedFiles,
    reason:bundle.rationale||'Runtime adapter has not been confirmed.',
  }));
  report.summary={
    profiles:report.profiles.length,deltaFiles:report.profiles.reduce((n,p)=>n+p.deltaFiles,0),
    cleanMerges:report.profiles.reduce((n,p)=>n+p.autoMerged,0),additionsMounted:report.profiles.reduce((n,p)=>n+p.additionsMounted,0),
    sourceChangesMounted:report.profiles.reduce((n,p)=>n+p.sourceChangesMounted,0),alreadyPresent:report.profiles.reduce((n,p)=>n+p.alreadyPresent,0),
    featureSourcesStaged:report.profiles.reduce((n,p)=>n+p.featureSourcesStaged,0),
    referenceSourcesStaged:report.profiles.reduce((n,p)=>n+p.referenceSourcesStaged,0),independentBundles:report.featureBundles.length,
    excluded:report.profiles.reduce((n,p)=>n+p.excluded,0),pending:report.pending.length,integrationPending:report.integrationPending.length};
  report.ready=report.pending.length===0&&report.integrationPending.length===0;
  if (!o.auditOnly) {
    if (report.featureBundles.some((bundle) => bundle.stagedFiles.some((entry) => entry.kind === 'feature'))) {
      const featureDir=path.join(root,'.forge-source-features');
      await fs.mkdir(featureDir,{recursive:true});
      await fs.writeFile(path.join(featureDir,'FEATURES.json'),JSON.stringify({
        schemaVersion:1,policy:'immutable-source-isolation',runtimeEnabled:false,
        message:'Feature-owned module blobs are preserved byte-for-byte. They are not executed or imported automatically; explicit Forge adapters are required before READY.',
        bundles:report.featureBundles.map((bundle) => ({...bundle,stagedFiles:bundle.stagedFiles.filter((entry) => entry.kind === 'feature')})).filter((bundle) => bundle.stagedFiles.length),
      },null,2)+'\n');
    }
    if (report.featureBundles.some((bundle) => bundle.stagedFiles.some((entry) => entry.kind === 'reference'))) {
      const referenceDir=path.join(root,'.forge-source-references');
      await fs.mkdir(referenceDir,{recursive:true});
      await fs.writeFile(path.join(referenceDir,'REFERENCES.json'),JSON.stringify({
        schemaVersion:1,policy:'immutable-source-reference',referenceOnly:true,
        message:'These are exact source blobs from shared integration points, kept for review and adapter extraction. They are not active runtime files and never replace upstream paths.',
        bundles:report.featureBundles.map((bundle) => ({...bundle,stagedFiles:bundle.stagedFiles.filter((entry) => entry.kind === 'reference')})).filter((bundle) => bundle.stagedFiles.length),
      },null,2)+'\n');
    }
    await fs.writeFile(path.join(root,'SOURCE-DELTA-REPORT.json'),JSON.stringify(report,null,2)+'\n');
    await fs.writeFile(path.join(root,'SOURCE-DELTA-READY.json'),JSON.stringify({
      ready:report.ready,baseCommit:report.baseCommit,upstreamCommit:report.upstreamCommit,
      profiles:report.profiles.map((p)=>({id:p.id,commit:p.commit})),pendingDecisions:report.pending.length,
      pendingFeatureAdapters:report.integrationPending.length,
      report:'SOURCE-DELTA-REPORT.json'},null,2)+'\n');
  } else await fs.rm(root,{recursive:true,force:true}).catch(()=>{});
  return report;
}

function parseArgs(argv) {
  const a={command:argv[0]||'help',profiles:null,groups:null,out:null,report:null,force:false};
  for(let i=1;i<argv.length;i++){
    const t=argv[i];
    if(['--profiles','--include-groups','--out','--report'].includes(t)){
      const v=argv[i+1]; if(!v||v.startsWith('--'))throw new Error(t+' requires a value.');
      if(t==='--profiles')a.profiles=v.split(',').map((x)=>x.trim()).filter(Boolean);
      else if(t==='--include-groups')a.groups=v.split(',').map((x)=>x.trim()).filter(Boolean);
      else if(t==='--out')a.out=v; else a.report=v; i++;
    } else if(t==='--force')a.force=true; else throw new Error('Unknown option '+t);
  }
  if(a.groups&&a.groups.some((g)=>!GROUPS.includes(g)))throw new Error('Unknown group.');
  return a;
}

function help() {
  console.log([
    'Forge source-delta compatibility layer','','  node tools/source-overlay.mjs list',
    '  node tools/source-overlay.mjs audit [--include-groups runtime,build,operations,deployment] [--report <file>]',
    '  node tools/source-overlay.mjs compose --out <directory> [--profiles <ids>] [--include-groups <groups>] [--force]',
    '', 'audit compares immutable snapshots; compose creates an isolated upstream + delta tree.',
    'Unresolved choices or feature adapters block READY. Source repositories are never written.',
  ].join('\n'));
}

async function main(argv=process.argv.slice(2)) {
  const a=parseArgs(argv), cfg=await loadSourceDeltaConfig(), catalog=cfg.catalog, decisions=cfg.decisions, featureManifest=cfg.featureManifest;
  if(['help','--help','-h'].includes(a.command))return help();
  if(a.command==='list'){
    console.log('Baseline: '+catalog.upstream.baselineCommit);
    console.log('Upstream target: '+catalog.upstream.auditedTargetCommit);
    for(const p of catalog.profiles)console.log(p.id+'\t'+p.sourceVersion+'\t'+p.commit+'\t'+p.name);
    return;
  }
  if(!['audit','compose'].includes(a.command))throw new Error('Unknown command.');
  const profiles=a.profiles?catalog.profiles.filter((p)=>a.profiles.includes(p.id)):catalog.profiles;
  if(!profiles.length||(a.profiles&&profiles.length!==a.profiles.length))throw new Error('Unknown profile.');
  const chosen={...catalog,profiles}, groups=a.groups||DEFAULT_GROUPS, home=sourceOverlayHome();
  const managerRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  await assertOutside(home,[managerRoot]);
  const snapshots={
    base:await prepareSnapshot(home,'upstream v0.2.5 baseline',catalog.upstream.repository,catalog.upstream.targetRef,catalog.upstream.baselineCommit),
    target:await prepareSnapshot(home,'current upstream',catalog.upstream.repository,catalog.upstream.targetRef,catalog.upstream.auditedTargetCommit),
    profiles:{},
  };
  for(const p of profiles)snapshots.profiles[p.id]=await prepareSnapshot(home,p.name,p.repository,p.ref,p.commit);
  const outDir=a.out||path.join(home,'composed','upstream-'+catalog.upstream.auditedTargetCommit.slice(0,8));
  const chosenFeatures={...featureManifest,bundles:featureManifest.bundles.filter((bundle)=>profiles.some((p)=>p.id===bundle.profile))};
  const report=await buildSourceDeltaComposition({catalog:chosen,decisions,featureManifest:chosenFeatures,snapshots,outDir,groups,home,force:a.force,auditOnly:a.command==='audit',managerRoot});
  if(a.report){const dest=path.resolve(a.report);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,JSON.stringify(report,null,2)+'\n');}
  console.log('[source-overlay] base='+report.baseCommit+' upstream='+report.upstreamCommit+' summary='+JSON.stringify(report.summary));
  for(const p of report.profiles)console.log('[source-overlay] '+p.id+': delta='+p.deltaFiles+', cleanMerges='+p.autoMerged+', additions='+p.additionsMounted+', changes='+p.sourceChangesMounted+', featureFiles='+p.featureSourcesStaged+', excluded='+p.excluded+', pending='+p.pending+', groups='+JSON.stringify(p.byGroup));
  for(const f of report.integrationPending.slice(0,50))console.log('[source-overlay] PENDING-ADAPTER '+f.id+': '+f.name+' - '+f.reason);
  for(const p of report.pending.slice(0,100))console.log('[source-overlay] PENDING '+p.profile+':'+p.path+(p.id?' ['+p.id+']':'')+' - '+p.reason);
  if(report.pending.length>100)console.log('[source-overlay] remaining pending rows are in report.');
  if(report.staleDecisions.length)console.log('[source-overlay] stale choices: '+report.staleDecisions.join(', '));
  if(a.command==='compose'){
    console.log('[source-overlay] output='+outDir+' READY='+report.ready);
    if(!report.ready){process.exitCode=2;throw new Error('Unresolved owner decisions or inactive feature adapters prevent a READY composition.');}
  } else console.log('[source-overlay] read-only audit completed; source repos were not modified.');
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  main().catch((err)=>{console.error('[source-overlay] '+(err&&err.message?err.message:String(err)));if(process.exitCode!==2)process.exitCode=1;});
}
