import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import {
  MANAGER_HEALTH_PATH,
  buildProxyHeaders,
  createSourceRuntimeProxyServer,
  loadSourceRuntimeCatalog,
  pathIsWithin,
  runtimeInstallPath,
  stripProxyResponseHeaders,
  validateProfileCatalog,
} from '../tools/source-runtime.mjs';

test('catalog has two fixed full-server profiles and preserves UI/game file boundaries', async () => {
  const profiles = await loadSourceRuntimeCatalog();
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map((p) => p.id), ['stronghold-server', 'stronghold-server-server-agent']);
  for (const profile of profiles) {
    assert.match(profile.commit, /^[0-9a-f]{40}$/);
    assert.equal(profile.entry, 'server/index.js');
    for (const required of ['server/index.js', 'server/lobby.js', 'server/match/Match.js',
      'server/sim/Battle.js', 'shared/protocol.js', 'public/index.html', 'public/js/main.js',
      'public/css/screens/game.css']) {
      assert.ok(profile.requiredFiles.includes(required), profile.id + ' missing ' + required);
    }
  }
  const agent = profiles.find((p) => p.id === 'stronghold-server-server-agent');
  for (const required of ['server/lineupLibrary.js', 'server/lineupOutbox.js',
    'server/lineupPublish.js', 'server/lineupSync.js']) {
    assert.ok(agent.requiredFiles.includes(required));
  }
});

test('catalog validation rejects mutable/unpinned or unsafe profile paths', () => {
  const baseline = {
    schemaVersion: 1,
    profiles: [{
      id: 'example-server', name: 'Example', description: 'test',
      repository: 'https://github.com/example/server.git', ref: 'master',
      commit: 'a'.repeat(40), appVersion: '1.2.3', entry: 'server/index.js', healthPath: '/healthz',
      requiredFiles: ['package.json', 'public/index.html', 'public/js/main.js', 'public/css/screens/game.css'],
    }],
  };
  assert.equal(validateProfileCatalog(baseline).length, 1);
  assert.throws(() => validateProfileCatalog({
    ...baseline,
    profiles: [{ ...baseline.profiles[0], commit: 'master' }],
  }), /commit SHA/);
  assert.throws(() => validateProfileCatalog({
    ...baseline,
    profiles: [{ ...baseline.profiles[0], requiredFiles: [...baseline.profiles[0].requiredFiles, '../outside.js'] }],
  }), /Unsafe required file path/);
});

test('runtime path resolution is pinned and rejects paths outside the configured home', () => {
  const profile = { id: 'stronghold-server', commit: 'b'.repeat(40) };
  const home = '/tmp/source-runtime-home';
  const target = runtimeInstallPath(profile, home);
  assert.equal(target, '/tmp/source-runtime-home/stronghold-server/' + profile.commit);
  assert.equal(pathIsWithin(home, target), true);
  assert.equal(pathIsWithin(home, home), false);
  assert.equal(pathIsWithin(home, '/tmp/outside-runtime'), false);
  assert.equal(pathIsWithin(home, '/tmp/source-runtime-home/../outside-runtime'), false);
});

test('proxy replaces forwarded headers and removes hop-by-hop response headers', () => {
  const headers = buildProxyHeaders({
    host: 'game.example.test',
    connection: 'keep-alive, x-internal-hop',
    'x-internal-hop': 'secret',
    'x-forwarded-for': '203.0.113.10',
    'x-forwarded-proto': 'https',
    'content-length': '3',
  }, '::ffff:127.0.0.1', 'http');
  assert.equal(headers['x-forwarded-for'], '127.0.0.1');
  assert.equal(headers['x-forwarded-proto'], 'http');
  assert.equal(headers['x-forwarded-host'], 'game.example.test');
  assert.equal(headers['x-internal-hop'], undefined);
  assert.equal(headers['content-length'], '3');

  const responseHeaders = stripProxyResponseHeaders({
    'content-type': 'text/html',
    connection: 'keep-alive, x-private',
    'x-private': 'secret',
    'transfer-encoding': 'chunked',
  });
  assert.deepEqual(responseHeaders, { 'content-type': 'text/html' });
});

test('transparent manager proxy forwards normal HTTP, its health route, and WebSocket upgrades', async (t) => {
  const backend = http.createServer((request, response) => {
    const body = Buffer.from(JSON.stringify({
      path: request.url,
      forwardedFor: request.headers['x-forwarded-for'],
      forwardedProto: request.headers['x-forwarded-proto'],
      host: request.headers.host,
    }));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) });
    response.end(body);
  });
  backend.on('upgrade', (request, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = backend.address().port;
  const profile = {
    id: 'test-profile', commit: 'c'.repeat(40), appVersion: '1.0.0',
  };
  const proxy = createSourceRuntimeProxyServer({
    profile,
    backendPort,
    getBackendState: () => ({ alive: true, pid: 1234 }),
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = proxy.address().port;

  t.after(async () => {
    proxy.destroyClientConnections();
    await new Promise((resolve) => proxy.close(() => resolve()));
    await new Promise((resolve) => backend.close(() => resolve()));
  });

  const httpResult = await new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1', port: proxyPort, path: '/probe?q=1',
      headers: { 'x-forwarded-for': '203.0.113.99', 'x-forwarded-proto': 'https' },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
    });
    request.once('error', reject);
  });
  assert.equal(httpResult.status, 200);
  assert.equal(httpResult.data.path, '/probe?q=1');
  assert.equal(httpResult.data.forwardedFor, '127.0.0.1');
  assert.equal(httpResult.data.forwardedProto, 'http');

  const managerHealth = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: proxyPort, path: MANAGER_HEALTH_PATH }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(body) }));
    }).once('error', reject);
  });
  assert.equal(managerHealth.status, 200);
  assert.equal(managerHealth.data.profile, 'test-profile');
  assert.equal(managerHealth.data.commit, 'c'.repeat(40));

  const upgradeHeader = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let responseText = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for proxied WebSocket handshake'));
    }, 3000);
    socket.once('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        'Host: game.example.test',
        'Connection: Upgrade',
        'Upgrade: echo',
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      responseText += chunk.toString('latin1');
      if (responseText.includes('\r\n\r\n')) {
        clearTimeout(timer);
        socket.destroy();
        resolve(responseText.slice(0, responseText.indexOf('\r\n\r\n')));
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  assert.match(upgradeHeader, /^HTTP\/1\.1 101 Switching Protocols/);
});
