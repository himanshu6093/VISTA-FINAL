// Verify every importmap target resolves to a file on disk (both vision hosts).
import fs from 'node:fs';
import path from 'node:path';
const pages = [
  ['extension/src/offscreen/offscreen.html', 'extension/src/offscreen'],
  ['extension/src/vision-page/vision-page.html', 'extension/src/vision-page'],
];
let ok = true;
for (const [file, base] of pages) {
  console.log('--- ' + file);
  const html = fs.readFileSync(file, 'utf8');
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  for (const [k, v] of Object.entries(map.imports)) {
    const p = v.startsWith('./') || v.startsWith('../') ? path.join(base, v) : v;
    const hit = fs.existsSync(p);
    if (!hit) ok = false;
    console.log((hit ? 'OK ' : 'MISSING ') + k + ' -> ' + v);
  }
}
console.log(ok ? 'IMPORTMAP_ALL_RESOLVE' : 'IMPORTMAP_BROKEN');
if (!ok) process.exit(1);
