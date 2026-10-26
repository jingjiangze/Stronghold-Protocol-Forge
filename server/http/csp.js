// Site policy (DESIGN §32.11). Hash only import maps, never arbitrary inline script. Worker/UI policies are independent.
// worker-src 'self' is the asset service worker at /sw.js. blob: stays for workers the page already creates
// (the simulation worker). Do not add a remote worker origin. SIM_WORKER_CSP is that worker's own policy and
// must not gain the asset worker.
//
// Plugins may widen where the page *fetches from* (manifest 2 `csp`, shared/plugins/manifest.js readCsp) — never what it
// runs: `script-src`, `object-src` and `base-uri` are the engine's alone. Without such a plugin the header is byte-identical
// to what it was before the field existed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// SES evaluates confined code. This relaxation belongs only to the simulation Worker, never its parent document.
export const SIM_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'none'";

/** @param {string} publicDir @param {{ plugins?: any[], log?: object }} [opts] the loaded plugins, for their `csp` field */
export function siteCsp(publicDir, { plugins = null, log = null } = {}) {
  const hashes = new Set();
  for (const rel of ['index.html', 'studio/index.html', 'studio/console.html', 'dev/game-mock.html', 'dev/render-demo.html', 'dev/battle-perf.html', 'dev/uikit.html']) {
    let html;
    try { html = fs.readFileSync(path.join(publicDir, rel), 'utf8'); } catch { continue; }
    for (const m of html.matchAll(/<script\s+type=["']importmap["']\s*>([\s\S]*?)<\/script>/g)) {
      hashes.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    }
  }
  // the directives a plugin may add to (manifest 2 `csp`; the manifest validator already refused anything else)
  const extra = { img: [], media: [], connect: [], style: [], font: [], frame: [], worker: [] };
  let off = null;
  for (const p of Array.isArray(plugins) ? plugins : []) {
    const c = p && p.manifest && p.manifest.csp;
    if (!c) continue;
    // one plugin switching the policy off is enough: say which one, then serve no header at all
    if (c.off) { off = (p && p.id) || 'a plugin'; continue; }
    for (const [k, list] of Object.entries(c.directives || {})) {
      const bucket = extra[k];
      if (!bucket) continue;
      for (const s of list) if (!bucket.includes(s)) bucket.push(s);
    }
  }
  if (off) {
    log?.warn?.(`[csp] plugin "${off}" set "csp": "off" — the site CSP header is disabled for this process`);
    return null;
  }
  const add = (k) => (extra[k].length ? ' ' + extra[k].join(' ') : '');
  // media-src is not in the base policy: it appears only when a plugin widened it (media-src 'self' blob: is the floor there)
  const media = extra.media.length ? `; media-src 'self' blob:${add('media')}` : '';
  return `default-src 'self'; script-src 'self'${hashes.size ? ' ' + [...hashes].join(' ') : ''}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${add('style')}; font-src 'self' https://fonts.gstatic.com${add('font')}; img-src 'self' data: blob:${add('img')}; connect-src 'self'${add('connect')}${media}; worker-src 'self' blob:${add('worker')}; frame-src 'self'${add('frame')}; object-src 'none'; base-uri 'none'`;
}
