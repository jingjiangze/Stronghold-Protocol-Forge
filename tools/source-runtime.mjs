#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import http, { request as httpRequest, get as httpGet } from 'node:http';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const CATALOG_URL = new URL('../config/source-runtime-profiles.json', import.meta.url);
export const MANAGER_HEALTH_PATH = '/_manager/source-runtime/healthz';
const READY_MARKER = '.source-runtime-ready.json';
const REQUIRED_UI_FILES = ['public/index.html', 'public/js/main.js', 'public/css/screens/game.css'];
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
const MAX_UPGRADE_ERROR_BYTES = 64 * 1024;

export function validateProfileCatalog(document) {
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.profiles)) {
    throw new Error('Invalid source runtime catalog: expected schemaVersion 1 and profiles[]');
  }
  const ids = new Set();
  const profiles = document.profiles.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid source runtime profile entry');
    const profile = { ...raw };
    if (typeof profile.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.id)) {
      throw new Error('Invalid source runtime profile id');
    }
    if (ids.has(profile.id)) throw new Error('Duplicate source runtime profile: ' + profile.id);
    ids.add(profile.id);
    if (typeof profile.repository !== 'string'
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(profile.repository)) {
      throw new Error('Profile ' + profile.id + ' must use an HTTPS GitHub repository URL');
    }
    if (typeof profile.ref !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(profile.ref) || profile.ref.includes('..')) {
      throw new Error('Invalid source ref for profile ' + profile.id);
    }
    if (typeof profile.commit !== 'string' || !/^[0-9a-f]{40}$/.test(profile.commit)) {
      throw new Error('Profile ' + profile.id + ' must pin a full 40-character commit SHA');
    }
    if (typeof profile.appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(profile.appVersion)) {
      throw new Error('Invalid appVersion for profile ' + profile.id);
    }
    if (profile.entry !== 'server/index.js' || profile.healthPath !== '/healthz') {
      throw new Error('Profile ' + profile.id + ' has an unsupported entry or health path');
    }
    if (!Array.isArray(profile.requiredFiles) || !REQUIRED_UI_FILES.every((p) => profile.requiredFiles.includes(p))) {
      throw new Error('Profile ' + profile.id + ' must declare the core game UI files');
    }
    for (const item of profile.requiredFiles) {
      if (typeof item !== 'string' || item.includes('\\') || path.posix.isAbsolute(item)
        || path.posix.normalize(item) !== item || item.split('/').includes('..')) {
        throw new Error('Unsafe required file path in profile ' + profile.id);
      }
    }
    if (typeof profile.name !== 'string' || typeof profile.description !== 'string') {
      throw new Error('Profile ' + profile.id + ' must have a name and description');
    }
    profile.requiredFiles = [...profile.requiredFiles];
    return Object.freeze(profile);
  });
  return Object.freeze(profiles);
}

export async function loadSourceRuntimeCatalog() {
  const document = JSON.parse(await fs.readFile(CATALOG_URL, 'utf8'));
  return validateProfileCatalog(document);
}

export function sourceRuntimeHome(env = process.env, userHome = os.homedir()) {
  const override = typeof env.SP_SOURCE_RUNTIME_HOME === 'string' ? env.SP_SOURCE_RUNTIME_HOME.trim() : '';
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('SP_SOURCE_RUNTIME_HOME must be an absolute path');
    return path.resolve(override);
  }
  return path.join(userHome, '.stronghold-protocol-forge', 'source-runtimes');
}

export function pathIsWithin(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function runtimeInstallPath(profile, home = sourceRuntimeHome()) {
  const root = path.resolve(home);
  const target = path.resolve(root, profile.id, profile.commit);
  if (!pathIsWithin(root, target)) throw new Error('Resolved runtime path is outside the managed runtime home');
  return target;
}

function captureCommand(command, args, options = {}) {
  const executable = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: process.platform === 'win32' && command === 'npm',
      stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(command + ' ' + args.join(' ') + ' exited with code ' + code));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function ensureHomeOutsideGitWorktree(home) {
  await fs.mkdir(home, { recursive: true });
  try {
    const root = await captureCommand('git', ['-C', home, 'rev-parse', '--show-toplevel'], { quiet: true });
    if (root) {
      const rootPath = path.resolve(root);
      const homePath = path.resolve(home);
      if (rootPath === homePath || pathIsWithin(rootPath, homePath)) {
        throw new Error('Runtime cache must be outside every Git worktree; refusing to write under ' + root);
      }
    }
  } catch (error) {
    if (String(error.message || error).startsWith('Runtime cache must be outside')) throw error;
    // A non-repository home is expected. Git itself will be checked by installation if needed.
  }
}

function profileAt(profiles, id) {
  const profile = profiles.find((item) => item.id === id);
  if (!profile) throw new Error('Unknown source runtime profile "' + id + '". Run the list command first.');
  return profile;
}

async function assertRuntimeSourceTree(root, profile) {
  const packageFile = path.join(root, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  if (packageJson.version !== profile.appVersion) {
    throw new Error('Package version mismatch for ' + profile.id + ': expected ' + profile.appVersion
      + ', got ' + String(packageJson.version));
  }
  if (packageJson.main !== profile.entry) {
    throw new Error('Unexpected package entry for ' + profile.id + ': ' + String(packageJson.main));
  }
  for (const relative of profile.requiredFiles) {
    const absolute = path.resolve(root, ...relative.split('/'));
    if (!pathIsWithin(root, absolute)) throw new Error('Required path escaped source runtime root: ' + relative);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Required game/runtime file is missing or not a regular file: ' + relative);
    }
  }
  return packageJson;
}

async function assertVendorReady(root) {
  const vendorDir = path.join(root, 'public', 'vendor');
  const entries = await fs.readdir(vendorDir).catch(() => []);
  if (entries.length === 0) {
    throw new Error('public/vendor is empty after npm ci; refusing to serve an incomplete game UI');
  }
}

async function readReadyMarker(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, READY_MARKER), 'utf8'));
  } catch {
    return null;
  }
}

export async function verifyInstalledProfile(profile, home = sourceRuntimeHome()) {
  const root = runtimeInstallPath(profile, home);
  if (!fsSync.existsSync(root)) throw new Error('Profile is not installed: ' + profile.id + '. Run install first.');
  const actualCommit = await captureCommand('git', ['rev-parse', 'HEAD'], { cwd: root, quiet: true });
  if (actualCommit !== profile.commit) {
    throw new Error('Installed checkout SHA mismatch for ' + profile.id + ': expected ' + profile.commit + ', got ' + actualCommit);
  }
  await assertRuntimeSourceTree(root, profile);
  await assertVendorReady(root);
  const marker = await readReadyMarker(root);
  if (!marker || marker.profileId !== profile.id || marker.commit !== profile.commit
    || marker.appVersion !== profile.appVersion || marker.ready !== true) {
    throw new Error('Runtime installation marker is missing or inconsistent for ' + profile.id);
  }
  if (!fsSync.existsSync(path.join(root, 'node_modules'))) {
    throw new Error('Runtime dependencies are missing for ' + profile.id + '; run install again in a clean cache');
  }
  return { profile, root, actualCommit, marker };
}

export async function installSourceRuntime(profile, home = sourceRuntimeHome()) {
  await ensureHomeOutsideGitWorktree(home);
  const target = runtimeInstallPath(profile, home);
  const targetParent = path.dirname(target);
  await fs.mkdir(targetParent, { recursive: true });
  if (fsSync.existsSync(target)) return verifyInstalledProfile(profile, home);

  const temporary = await fs.mkdtemp(path.join(targetParent, '.install-'));
  let moved = false;
  try {
    console.log('Cloning ' + profile.repository + ' at the pinned runtime commit...');
    await captureCommand('git', [
      'clone', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', profile.ref,
      profile.repository, temporary,
    ]);
    await captureCommand('git', ['fetch', '--depth', '1', 'origin', profile.commit], { cwd: temporary });
    await captureCommand('git', ['checkout', '--detach', profile.commit], { cwd: temporary });
    const actualCommit = await captureCommand('git', ['rev-parse', 'HEAD'], { cwd: temporary, quiet: true });
    if (actualCommit !== profile.commit) {
      throw new Error('Checkout SHA mismatch: expected ' + profile.commit + ', got ' + actualCommit);
    }
    await assertRuntimeSourceTree(temporary, profile);

    console.log('Installing production dependencies in the isolated runtime copy (source repository remains untouched)...');
    await captureCommand('npm', ['ci', '--omit=dev'], {
      cwd: temporary,
      env: { ...process.env, CI: '1' },
    });
    await assertVendorReady(temporary);
    await fs.writeFile(path.join(temporary, READY_MARKER), JSON.stringify({
      ready: true,
      profileId: profile.id,
      repository: profile.repository,
      ref: profile.ref,
      commit: profile.commit,
      appVersion: profile.appVersion,
      installedAt: new Date().toISOString(),
      sourceTreeIsolated: true,
    }, null, 2) + '\n', 'utf8');

    try {
      await fs.rename(temporary, target);
      moved = true;
    } catch (error) {
      if (!fsSync.existsSync(target)) throw error;
      // Another installer may have completed the exact same pinned profile concurrently.
      await verifyInstalledProfile(profile, home);
      return { profile, root: target, actualCommit: profile.commit, marker: await readReadyMarker(target) };
    }
    return verifyInstalledProfile(profile, home);
  } finally {
    if (!moved) {
      await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function normalizeAddress(address) {
  if (typeof address !== 'string' || !address) return 'unknown';
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const value = mapped ? mapped[1] : address;
  return /^[0-9a-fA-F:.%]+$/.test(value) ? value : 'unknown';
}

export function buildProxyHeaders(incomingHeaders, remoteAddress, protocol = 'http', options = {}) {
  const headers = {};
  const connectionTokens = new Set(String(incomingHeaders.connection || '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lower = key.toLowerCase();
    if (lower === 'x-forwarded-for' || lower === 'x-forwarded-proto' || lower === 'x-forwarded-host') continue;
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) {
      if (options.upgrade && (lower === 'connection' || lower === 'upgrade')) headers[lower] = value;
      continue;
    }
    headers[lower] = value;
  }
  headers['x-forwarded-for'] = normalizeAddress(remoteAddress);
  headers['x-forwarded-proto'] = protocol === 'https' ? 'https' : 'http';
  if (typeof incomingHeaders.host === 'string') headers['x-forwarded-host'] = incomingHeaders.host;
  if (options.upgrade) {
    headers.connection = 'Upgrade';
    if (typeof incomingHeaders.upgrade === 'string') headers.upgrade = incomingHeaders.upgrade;
  }
  return headers;
}

export function stripProxyResponseHeaders(incomingHeaders) {
  const headers = {};
  const connectionTokens = new Set(String(incomingHeaders.connection || '')
    .split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
  for (const [key, value] of Object.entries(incomingHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    headers[lower] = value;
  }
  return headers;
}

function writeRawResponse(socket, statusCode, statusMessage, headers, body) {
  if (socket.destroyed) return;
  socket.write('HTTP/1.1 ' + statusCode + ' ' + (statusMessage || 'Proxy Error') + '\r\n');
  for (const [key, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || rawValue === null) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) socket.write(key + ': ' + String(value) + '\r\n');
  }
  socket.write('\r\n');
  socket.end(body);
}

function respondProxyError(response, statusCode, message) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  const body = Buffer.from(message, 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(body);
}

function requestProtocol(request) {
  return request.socket && request.socket.encrypted ? 'https' : 'http';
}

export function createSourceRuntimeProxyServer(options) {
  const profile = options.profile;
  const backendPort = options.backendPort;
  const getBackendState = typeof options.getBackendState === 'function'
    ? options.getBackendState : () => options.backendState || { alive: true, pid: null };
  const publicProtocol = options.publicProtocol ?? null;
  if (publicProtocol !== null && !['http', 'https'].includes(publicProtocol)) {
    throw new Error('publicProtocol must be "http", "https", or null for direct-protocol detection');
  }
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url || '/', 'http://source-runtime.invalid').pathname;
    } catch {
      respondProxyError(response, 400, 'Invalid request path');
      return;
    }
    const state = getBackendState();
    if (request.method === 'GET' && pathname === MANAGER_HEALTH_PATH) {
      const healthy = !!state.alive;
      const body = Buffer.from(JSON.stringify({
        ok: healthy,
        managed: true,
        profile: profile.id,
        commit: profile.commit,
        appVersion: profile.appVersion,
        childPid: state.pid || null,
        childAlive: healthy,
      }), 'utf8');
      response.writeHead(healthy ? 200 : 503, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store',
      });
      response.end(body);
      return;
    }
    if (!state.alive) {
      respondProxyError(response, 503, 'The managed game runtime is not running');
      return;
    }
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: backendPort,
      method: request.method,
      path: request.url || '/',
      headers: buildProxyHeaders(request.headers, request.socket.remoteAddress, publicProtocol || requestProtocol(request)),
      agent: false,
    }, (upstreamResponse) => {
      if (response.destroyed) return;
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage,
        stripProxyResponseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(response);
    });
    upstream.once('error', () => respondProxyError(response, 502, 'Managed runtime proxy could not reach the game server'));
    request.once('aborted', () => upstream.destroy());
    response.once('close', () => { if (!response.writableEnded) upstream.destroy(); });
    request.pipe(upstream);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, clientSocket, clientHead) => {
    const state = getBackendState();
    if (!state.alive) {
      writeRawResponse(clientSocket, 503, 'Service Unavailable', {
        connection: 'close', 'content-length': '0',
      }, Buffer.alloc(0));
      return;
    }
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: backendPort,
      method: request.method || 'GET',
      path: request.url || '/',
      headers: buildProxyHeaders(request.headers, request.socket.remoteAddress, publicProtocol || requestProtocol(request), { upgrade: true }),
      agent: false,
    });
    let completed = false;
    upstream.once('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      completed = true;
      if (clientSocket.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      clientSocket.write('HTTP/1.1 ' + (upstreamResponse.statusCode || 101) + ' '
        + (upstreamResponse.statusMessage || 'Switching Protocols') + '\r\n');
      const rawHeaders = upstreamResponse.rawHeaders || [];
      for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
        clientSocket.write(rawHeaders[index] + ': ' + rawHeaders[index + 1] + '\r\n');
      }
      clientSocket.write('\r\n');
      if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead);
      if (clientHead && clientHead.length) upstreamSocket.write(clientHead);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      const destroyPeer = () => {
        if (!upstreamSocket.destroyed) upstreamSocket.destroy();
        if (!clientSocket.destroyed) clientSocket.destroy();
      };
      clientSocket.once('error', destroyPeer);
      upstreamSocket.once('error', destroyPeer);
      clientSocket.once('close', () => { if (!upstreamSocket.destroyed) upstreamSocket.destroy(); });
      upstreamSocket.once('close', () => { if (!clientSocket.destroyed) clientSocket.destroy(); });
    });
    upstream.once('response', (upstreamResponse) => {
      const chunks = [];
      let totalBytes = 0;
      let tooLarge = false;
      upstreamResponse.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_UPGRADE_ERROR_BYTES) chunks.push(chunk);
        else tooLarge = true;
      });
      upstreamResponse.once('end', () => {
        if (completed || clientSocket.destroyed) return;
        const body = tooLarge ? Buffer.from('Upstream rejected the WebSocket upgrade', 'utf8') : Buffer.concat(chunks);
        const headers = stripProxyResponseHeaders(upstreamResponse.headers);
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        headers.connection = 'close';
        headers['content-length'] = String(body.length);
        writeRawResponse(clientSocket, tooLarge ? 502 : (upstreamResponse.statusCode || 502),
          tooLarge ? 'Bad Gateway' : (upstreamResponse.statusMessage || 'Bad Gateway'), headers, body);
      });
    });
    upstream.once('error', () => {
      if (completed || clientSocket.destroyed) return;
      writeRawResponse(clientSocket, 502, 'Bad Gateway', {
        connection: 'close', 'content-length': '0',
      }, Buffer.alloc(0));
    });
    clientSocket.once('close', () => upstream.destroy());
    upstream.end();
  });

  Object.defineProperty(server, 'destroyClientConnections', {
    value: () => { for (const socket of sockets) socket.destroy(); },
  });
  return server;
}

async function getFreeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('Could not allocate an internal loopback port');
  return port;
}

function probeHealth(port, healthPath) {
  return new Promise((resolve) => {
    const request = httpGet({ hostname: '127.0.0.1', port, path: healthPath, timeout: 1200 }, (response) => {
      const code = response.statusCode || 0;
      response.resume();
      resolve(code === 200);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

async function waitForBackendReady(child, state, port, healthPath) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!state.alive || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('The selected runtime exited before its health check became ready');
    }
    if (await probeHealth(port, healthPath)) return;
    await sleep(200);
  }
  throw new Error('Runtime did not return HTTP 200 from ' + healthPath + ' within 20 seconds');
}

async function terminateChild(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = () => new Promise((resolve) => child.once('exit', resolve));
  const exited = waitForExit();
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(timeoutMs)]);
  if (child.exitCode === null && child.signalCode === null) {
    const forcedExit = waitForExit();
    child.kill('SIGKILL');
    await Promise.race([forcedExit, sleep(1000)]);
  }
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function serveProfile(profile, publicOptions, home) {
  const installation = await verifyInstalledProfile(profile, home);
  await ensureHomeOutsideGitWorktree(home);
  const backendPort = await getFreeLoopbackPort();
  const childEnv = {
    ...process.env,
    PORT: String(backendPort),
    HOST: '127.0.0.1',
    TRUST_PROXY: 'auto',
    SP_SOURCE_RUNTIME_PROFILE: profile.id,
    SP_SOURCE_RUNTIME_COMMIT: profile.commit,
  };
  const child = spawn(process.execPath, [profile.entry], {
    cwd: installation.root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { alive: true, pid: child.pid || null, exitCode: null, signal: null };
  let shuttingDown = false;
  const forwardOutput = (stream, label) => {
    let pending = '';
    stream.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) if (line) console.log('[' + profile.id + ' ' + label + '] ' + line);
    });
    stream.on('end', () => {
      if (pending) console.log('[' + profile.id + ' ' + label + '] ' + pending);
    });
  };
  forwardOutput(child.stdout, 'out');
  forwardOutput(child.stderr, 'err');
  child.once('error', (error) => {
    state.alive = false;
    console.error('[' + profile.id + '] failed to spawn runtime: ' + error.message);
  });
  child.once('exit', (code, signal) => {
    state.alive = false;
    state.exitCode = code;
    state.signal = signal;
    if (!shuttingDown) console.error('[' + profile.id + '] runtime exited unexpectedly (code=' + code + ', signal=' + signal + ')');
  });

  try {
    await waitForBackendReady(child, state, backendPort, profile.healthPath);
  } catch (error) {
    await terminateChild(child);
    throw error;
  }

  const proxy = createSourceRuntimeProxyServer({
    profile,
    backendPort,
    publicProtocol: publicOptions.publicProtocol,
    getBackendState: () => state,
  });
  try {
    await listen(proxy, publicOptions.port, publicOptions.host);
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
  console.log('Profile: ' + profile.id + ' @ ' + profile.commit);
  console.log('Runtime copy: ' + installation.root);
  console.log('Public game URL: http://' + publicOptions.host + ':' + publicOptions.port + '/');
  console.log('Manager health: http://' + publicOptions.host + ':' + publicOptions.port + MANAGER_HEALTH_PATH);
  console.log('The game server is isolated on 127.0.0.1:' + backendPort + '; Ctrl+C stops both processes.');

  let resolveRun;
  const finished = new Promise((resolve) => { resolveRun = resolve; });
  let shutdownPromise = null;
  const shutdown = (reason) => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      proxy.destroyClientConnections();
      await new Promise((resolve) => proxy.close(() => resolve()));
      await terminateChild(child);
      if (reason === 'child-exit') process.exitCode = 1;
      resolveRun();
    })();
    return shutdownPromise;
  };
  const onSignal = () => { void shutdown('signal'); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  child.once('exit', () => {
    if (!shuttingDown) void shutdown('child-exit');
  });
  if (!state.alive) void shutdown('child-exit');
  await finished;
}

function parseServeOptions(argumentsList) {
  const configuredProtocol = process.env.SOURCE_RUNTIME_PUBLIC_PROTOCOL || 'auto';
  if (!['auto', 'http', 'https'].includes(configuredProtocol)) {
    throw new Error('SOURCE_RUNTIME_PUBLIC_PROTOCOL must be auto, http, or https');
  }
  const options = {
    port: Number(process.env.PORT || 3000),
    host: process.env.SOURCE_RUNTIME_HOST || '127.0.0.1',
    publicProtocol: configuredProtocol === 'auto' ? null : configuredProtocol,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const key = argumentsList[index];
    if (key === '--port') {
      const raw = argumentsList[index + 1];
      if (!raw) throw new Error('--port requires a number');
      options.port = Number(raw);
      index += 1;
    } else if (key === '--host') {
      const raw = argumentsList[index + 1];
      if (!raw || raw.startsWith('--')) throw new Error('--host requires an address');
      options.host = raw;
      index += 1;
    } else {
      throw new Error('Unknown option: ' + key);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('Public port must be an integer from 1 to 65535');
  }
  return options;
}

function printHelp() {
  console.log([
    'Forge source-runtime manager',
    '',
    'Commands:',
    '  node tools/source-runtime.mjs list',
    '  node tools/source-runtime.mjs install <profile-id>',
    '  node tools/source-runtime.mjs verify <profile-id>',
    '  node tools/source-runtime.mjs serve <profile-id> [--port 3000] [--host 127.0.0.1]',
    '',
    'The runtime is cloned to a manager-owned cache outside Git worktrees. Source repositories are never edited.',
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const [command, profileId, ...rest] = argv;
  const profiles = await loadSourceRuntimeCatalog();
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'list') {
    for (const profile of profiles) {
      console.log(profile.id + '\t' + profile.appVersion + '\t' + profile.commit
        + '\t' + profile.name + '\t' + profile.description);
    }
    return;
  }
  const profile = profileAt(profiles, profileId);
  const home = sourceRuntimeHome();
  if (command === 'install') {
    const result = await installSourceRuntime(profile, home);
    console.log('READY ' + profile.id + ' @ ' + result.actualCommit);
    console.log('Runtime path: ' + result.root);
    return;
  }
  if (command === 'verify') {
    const result = await verifyInstalledProfile(profile, home);
    console.log(JSON.stringify({
      ready: true, profile: profile.id, repository: profile.repository,
      commit: result.actualCommit, appVersion: profile.appVersion, runtimePath: result.root,
    }, null, 2));
    return;
  }
  if (command === 'serve') {
    const options = parseServeOptions(rest);
    await serveProfile(profile, options, home);
    return;
  }
  throw new Error('Unknown command: ' + command);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error('[source-runtime] ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
}
