// 构建 wm/worldmap.js 与 wm/geodata.js —— 从 worldmonitor 源码提取静态地理数据并预投影
// 用法: node build_assets.js <SOURCE_DIR> [OUT_DIR] [BUILT_AT] [UPSTREAM_REF]
//   SOURCE_DIR : worldmonitor 源码根目录 (含 shared/ src/ public/)
//   OUT_DIR    : 输出目录, 默认本脚本所在目录
//   BUILT_AT   : 快照日期 YYYY-MM-DD, 默认今天(UTC+8)
//   UPSTREAM_REF: 上游 commit 短哈希, 默认 'local'
// 任一图层提取失败即报错退出(不写文件), 保证线上资产不被半成品覆盖
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..', 'worldmonitor');
const OUT = process.argv[3] || __dirname;
const BUILT_AT = process.argv[4] || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const UPSTREAM = process.argv[5] || 'local';

// ---------- 提取 TS 文件中 export const NAME = [ ... ] 的数组字面量 ----------
function extractArray(src, name) {
  const re = new RegExp('export const ' + name + '\\s*(:[^=]+)?=\\s*\\[', 'g');
  const m = re.exec(src);
  if (!m) throw new Error('not found: ' + name);
  let i = m.index + m[0].length - 1; // 指向 '['
  let depth = 0, str = null, esc = false, out = '';
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { str = ch; out += ch; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += ' '; continue; }
    if (ch === '/' && src[i + 1] === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; out += ' '; continue; }
    if (ch === '[') depth++;
    if (ch === ']') { depth--; }
    out += ch;
    if (depth === 0) break;
  }
  // eslint-disable-next-line no-eval
  return eval('(' + out + ')');
}

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

const geoData = read('shared/geo-data.ts');
const basesData = read('shared/military-bases-data.ts');
const pipesData = read('shared/pipelines-data.ts');
const geoMap = read('src/config/geo-map.ts');
const aiDc = read('src/config/ai-datacenters.ts');

const hotspots = extractArray(geoData, 'INTEL_HOTSPOTS');
const waterways = extractArray(geoData, 'STRATEGIC_WATERWAYS');
const zones = extractArray(geoData, 'CONFLICT_ZONES');
const bases = extractArray(basesData, 'MILITARY_BASES_EXPANDED');
const pipelines = extractArray(pipesData, 'PIPELINES');
const cables = extractArray(geoMap, 'UNDERSEA_CABLES');
const nuclear = extractArray(geoMap, 'NUCLEAR_FACILITIES');
const spaceports = extractArray(geoMap, 'SPACEPORTS');
const dcs = extractArray(aiDc, 'AI_DATA_CENTERS');

console.log('counts:', { hotspots: hotspots.length, waterways: waterways.length, zones: zones.length, bases: bases.length, pipelines: pipelines.length, cables: cables.length, nuclear: nuclear.length, spaceports: spaceports.length, dcs: dcs.length });

// ---------- 热点"情报更新小时数"(研究估算): 主要ID人工设定, 其余按升级分数确定性推导 ----------
const H_CURATED = { ukraine: 1, iran: 2, israel_gaza: 4, red_sea: 6, sudan: 12, sahel: 20, myanmar: 30, north_korea: 26, taiwan: 18, venezuela: 40, haiti: 60, somalia: 55, libya: 70, yemen: 6, kashmir: 48, syria: 36, iraq: 30, colombia: 90, mexico: 15, sahara: 80, mozambique: 96, nigeria: 44, congo: 50, ethiopia: 75, lebanon: 5, pakistan: 52, afghanistan: 65, south_china_sea: 22, horn_of_africa: 46 };
function hoursOf(h) {
  for (const k in H_CURATED) if ((h.id || '').includes(k)) return H_CURATED[k];
  const s = h.escalationScore || 3;
  let hash = 0; for (const c of h.id) hash = (hash * 31 + c.charCodeAt(0)) % 97;
  return Math.min(160, Math.max(2, Math.round(170 - s * 28 + (hash % 24))));
}

const slim = (v, d = 2) => Math.round(v * 100) / 100;
const GEO = {
  builtAt: BUILT_AT,
  upstream: UPSTREAM,
  hotspots: hotspots.map(h => ({ id: h.id, n: h.name, st: h.subtext || '', la: slim(h.lat), lo: slim(h.lon), s: h.status || 'Monitoring', e: h.escalationScore || 3, d: (h.description || '').slice(0, 160), h: hoursOf(h) })),
  waterways: waterways.map(w => ({ n: w.name, la: slim(w.lat), lo: slim(w.lon), d: (w.description || '') })),
  zones: zones.map(z => ({ id: z.id, n: z.name, c: z.coords.map(p => [slim(p[0]), slim(p[1])]), i: z.intensity || 'medium', d: (z.description || '').slice(0, 160), p: (z.parties || []).slice(0, 4) })),
  bases: bases.map(b => ({ n: b.name, la: slim(b.lat), lo: slim(b.lon), t: b.type || 'us-nato' })),
  nuclear: nuclear.filter(x => x.status === 'active').map(x => ({ n: x.name, la: slim(x.lat), lo: slim(x.lon), t: x.type || 'plant' })),
  cables: cables.filter(c => c.major).map(c => ({ n: c.name, pts: c.points.map(p => [slim(p[0]), slim(p[1])]) })),
  pipelines: pipelines.map(p => ({ n: p.name, t: p.type, s: p.status, pts: p.points.map(q => [slim(q[0]), slim(q[1])]) })),
  spaceports: spaceports.filter(s => s.status === 'active').map(s => ({ n: s.name, la: slim(s.lat), lo: slim(s.lon) })),
  dcs: dcs.map(d => ({ n: d.name.split(',')[0], la: slim(d.lat), lo: slim(d.lon), o: (d.owner || '').split(',')[0] })),
};
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'geodata.js'), 'window.WM_GEO=' + JSON.stringify(GEO) + ';\n');
console.log('geodata.js KB:', Math.round(fs.statSync(path.join(OUT, 'geodata.js')).size / 1024));

// ---------- TopoJSON → SVG paths (等距圆柱投影, viewBox 1000x500) ----------
const topo = JSON.parse(read('public/data/countries-110m.json'));
const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
const arcs = topo.arcs.map(arc => {
  let x = 0, y = 0;
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
});
function ring(idxList) {
  let pts = [];
  for (const idx of idxList) {
    let a = idx >= 0 ? arcs[idx] : arcs[~idx].slice().reverse();
    if (pts.length) a = a.slice(1);
    pts = pts.concat(a);
  }
  return pts;
}
const PX = (lon) => Math.round((lon + 180) * (1000 / 360) * 10) / 10;
const PY = (lat) => Math.round((90 - lat) * (500 / 180) * 10) / 10;
function ringPath(r) {
  let d = '', prev = '';
  for (const [lon, lat] of r) {
    const s = PX(lon) + ',' + PY(lat);
    if (s === prev) continue;
    d += (d ? 'L' : 'M') + s;
    prev = s;
  }
  return d + 'Z';
}
const paths = [];
for (const g of topo.objects.countries.geometries) {
  let rings = [];
  if (g.type === 'Polygon') rings = g.arcs.map(ring);
  else if (g.type === 'MultiPolygon') rings = g.arcs.flat().map(ring);
  let d = '';
  for (const r of rings) {
    if (r.length < 4) continue;
    const pd = ringPath(r);
    if (pd.length > 12) d += pd; // 丢弃投影后极小的碎岛
  }
  if (d) paths.push(d);
}
fs.writeFileSync(path.join(OUT, 'worldmap.js'), 'window.WM_WORLD=' + JSON.stringify({ w: 1000, h: 500, paths }) + ';\n');
console.log('worldmap.js KB:', Math.round(fs.statSync(path.join(OUT, 'worldmap.js')).size / 1024), 'paths:', paths.length);
console.log('builtAt:', BUILT_AT, 'upstream:', UPSTREAM);
