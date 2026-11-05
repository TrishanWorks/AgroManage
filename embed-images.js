'use strict';
// Puts your pictures INSIDE public/index.html so they always load, even with no image folder.
// Usage: put agro1..agro7 and t1..t3 (any of jpg, jpeg, png, webp) in this folder, public/ or public/img/, then run:
//   node embed-images.js
const fs = require('fs'), path = require('path');
const ROOT = __dirname, DIRS = [ROOT, path.join(ROOT, 'public'), path.join(ROOT, 'public', 'img'), path.join(ROOT, 'img'), path.join(ROOT, 'images'), path.join(ROOT, 'assets')];
const RE = /\.(jpe?g|png|webp|gif|avif)/i, WANT = ['agro1', 'agro2', 'agro3', 'agro4', 'agro5', 'agro6', 'agro7', 't1', 't2', 't3'];
const mime = b => b[0] === 0xFF && b[1] === 0xD8 ? 'image/jpeg' : b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b.slice(0, 4).toString() === 'RIFF' ? 'image/webp' : b.slice(0, 3).toString() === 'GIF' ? 'image/gif' : 'image/avif';
const found = {};
for (const d of DIRS) { let ns = []; try { ns = fs.readdirSync(d); } catch {}
  for (const n of ns) { if (!RE.test(n)) continue; const k = n.toLowerCase().replace(/\.(jpe?g|png|webp|gif|avif)/g, '').replace(/[^a-z0-9]/g, ''); if (WANT.includes(k) && !found[k]) found[k] = path.join(d, n); } }
const out = {}; let total = 0;
for (const k of WANT) if (found[k]) { const b = fs.readFileSync(found[k]); total += b.length; out[k] = `data:${mime(b)};base64,${b.toString('base64')}`; console.log(`  ${k}  <-  ${path.relative(ROOT, found[k])}  (${Math.round(b.length / 1024)} KB)`); }
const idx = path.join(ROOT, 'public', 'index.html'); let html = fs.readFileSync(idx, 'utf8');
if (!/<script id="embed">[\s\S]*?<\/script>/.test(html)) { console.error('index.html has no embed block.'); process.exit(1); }
html = html.replace(/<script id="embed">[\s\S]*?<\/script>/, () => `<script id="embed">window.EMBED=${JSON.stringify(out)}</script>`);
fs.writeFileSync(idx, html);
const miss = WANT.filter(k => !out[k]);
console.log(`Embedded ${Object.keys(out).length} of ${WANT.length} pictures (${(total / 1048576).toFixed(1)} MB of pictures).`);
if (miss.length) console.log(`Not found: ${miss.join(', ')}`);
if (total > 4 * 1048576) console.log('Warning: the page is now large. Resize the pictures (about 300 KB each) for fast loading on mobile data.');
