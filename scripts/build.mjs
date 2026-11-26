/* 界门交易行 · 构建脚本
 *
 * 独立项目的精简版构建：只打包这一个游戏，不含游戏厅。
 * 产物：dist/ + dist/release-manifest.json（sha256 清单，供静态校验用）。
 *
 * 与游戏厅版本的差异：
 *   - 不再读 content/games.json、index.html、play.html、src/hub.js
 *   - 美术资源改为扫描 assets/ 下的固定目录，新增图不会漏发
 *   - 文本类资源（art-index.js 等）走路径重写，让索引指向哈希后的文件名
 *
 * 用法：node scripts/build.mjs
 */
import {mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname, extname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 'V1';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function walk(dir) {
  if (!existsSync(resolve(root, dir))) return [];
  return readdirSync(resolve(root, dir), {withFileTypes: true})
    .flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}

// ── 保留上一版已发布的哈希文件 ─────────────────────────────────
// 旧链接在 CDN 上可能还有人访问，重建时不能凭空让它们 404。
//
// 这里要收集三类：
//   1. previous.retained / previous.previousFiles —— 更早版本留下的
//   2. previous.files 里带哈希的产物 —— 上一版构建刚生成的
//   3. 磁盘上存在、但清单没记的同目录哈希产物 —— 历史遗留的孤儿
//
// 原实现只在 version 变化时才会去看 previous.files，同版本重建时
// retained/previousFiles 都是空的，保留逻辑等于没生效：旧哈希文件
// 只是因为「build 从不删东西」而侥幸留在磁盘上，清单里没有任何记录，
// 于是 dist/ 无限膨胀，git 也把它们当成来路不明的孤儿文件。
const retained = {};
try {
  const previous = JSON.parse(readFileSync(resolve(root, 'dist/release-manifest.json'), 'utf8'));
  const candidates = new Map();

  const add = (item) => {
    if (!item || !item.path || !item.sha256) return;
    // 只保留带内容哈希的产物；页面（wasteland.html）没有哈希，不进保留列表
    if (!/\.[0-9a-f]{12}\./.test(item.path)) return;
    candidates.set(item.path, item);
  };
  Object.values(previous.retained || {}).forEach(add);
  Object.values(previous.previousFiles || {}).forEach(add);
  Object.values(previous.files || {}).forEach(add);

  // 扫 dist/ 下的哈希产物，把清单没记但磁盘还在的补进来
  //
  // 注意路径前缀：walk('dist') 返回的是 'dist/src/xxx.js'，
  // 而 retained 的键必须是**相对 dist/ 根**的 'src/xxx.js'。
  //
  // 原来这里直接把 'dist/src/xxx.js' 塞进 candidates，
  // 后面 `resolve(root,'dist',path)` 就变成了
  // 'dist/dist/src/xxx.js' —— 文件不存在，于是 `continue` 掉。
  //
  // 结果：这段「捞回孤儿产物」的逻辑**从来没生效过**。
  // 哈希产物每次构建换名，旧的就在磁盘上变成没人记录的孤儿，
  // dist/ 无限膨胀，清单里也查不到它们。
  for (const dir of walk('dist')) {
    if (!/\.[0-9a-f]{12}\./.test(dir)) continue;
    const rel = dir.replace(/^dist[\\/]/, '');   // ← 去掉 dist/ 前缀
    if (candidates.has(rel)) continue;
    const abs = resolve(root, dir);
    const bytes = readFileSync(abs);
    candidates.set(rel, {path: rel, sha256: sha(bytes), bytes: bytes.length});
  }

  for (const [path, item] of candidates) {
    const file = resolve(root, 'dist', path);
    if (!existsSync(file)) continue;          // 磁盘上已经没了就别留
    const bytes = readFileSync(file);
    if (sha(bytes) !== item.sha256) continue;  // 哈希对不上就不要留脏数据
    retained[path] = {bytes, sha256: item.sha256};
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const files = {}, aliases = {};

function put(source, bytes, folder) {
  const ext = extname(source);
  const name = basename(source, ext);
  const path = `${folder}/${name}.${sha(bytes).slice(0, 12)}${ext}`;
  mkdirSync(resolve(root, 'dist', dirname(path)), {recursive: true});
  writeFileSync(resolve(root, 'dist', path), bytes);
  files[source] = {
    path,
    sourceSha256: sha(readFileSync(resolve(root, source))),
    sha256: sha(bytes),
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes).length,
  };
}

// url() 与路径字符串要跟着哈希后的文件名走，否则索引指向一堆 404
function rewrite(text) {
  for (const [source, item] of Object.entries(files)) text = text.split(source).join(item.path);
  return text;
}

// ── 资源清单 ───────────────────────────────────────────────────
const ART_DIRS = ['assets/items', 'assets/machines', 'assets/facilities', 'assets/portraits', 'assets/worlds', 'assets/ui'];
const ROOT_ASSETS = [
  'assets/art-index.js',              // 索引（文本，需要重写）
  'assets/dimensional-market-hall.svg',
  'assets/icons/dimensional-trading-post.svg',
];
const STYLES = ['src/wasteland-shop.css', 'src/dimensional-trading-post.css'];
const SCRIPTS = ['src/wasteland-core.js', 'src/wasteland-npc.js', 'src/wasteland-ui.js', 'src/wasteland-shop.js'];
const PAGES = ['wasteland.html'];

const shipped = [
  ...ROOT_ASSETS,
  ...STYLES,
  ...SCRIPTS,
  ...ART_DIRS.flatMap(d => walk(d).filter(f => /\.(png|webp|jpg|jpeg)$/i.test(f))),
];

// 先放非文本资源，再放文本——rewrite 需要 files 表里已经有图片的最终路径
for (const source of shipped) {
  const isText = /\.(js|css|json|svg|html)$/i.test(source);
  const raw = readFileSync(resolve(root, source));
  put(source, isText ? Buffer.from(rewrite(raw.toString('utf8'))) : raw, dirname(source));
}

// 页面单独处理：写进 dist 根目录，而不是哈希目录
for (const page of PAGES) {
  const bytes = Buffer.from(rewrite(readFileSync(resolve(root, page), 'utf8')));
  writeFileSync(resolve(root, 'dist', page), bytes);
  files[page] = {
    path: page,
    sourceSha256: sha(readFileSync(resolve(root, page))),
    sha256: sha(bytes),
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes).length,
  };
}

// ── 上一版保留文件 ─────────────────────────────────────────────
const retainedManifest = {}, previousFiles = {};
for (const [path, item] of Object.entries(retained)) {
  // 本次构建刚产出的文件不算「上一版」，要跳过 ——
  // 否则 previousFiles 会把当前全部产物都记一遍（268 项），名不副实。
  if (Object.values(files).some(f => f.path === path)) continue;
  if (sha(item.bytes) !== item.sha256) throw new Error('Corrupt retained resource: ' + path);
  mkdirSync(resolve(root, 'dist', dirname(path)), {recursive: true});
  writeFileSync(resolve(root, 'dist', path), item.bytes);
  retainedManifest[path] = {path, sha256: item.sha256, bytes: item.bytes.length};
  previousFiles[path] = {path, sha256: item.sha256, bytes: item.bytes.length};
}

writeFileSync(resolve(root, 'dist/release-manifest.json'),
  JSON.stringify({version: VERSION, files, aliases, retained: retainedManifest, previousFiles}, null, 2) + '\n');

const pageGzip = PAGES.reduce((sum, p) => sum + files[p].gzipBytes, 0);
console.log(`Built ${VERSION}; page gzip: ${pageGzip} bytes; ${Object.keys(files).length} files.`);
