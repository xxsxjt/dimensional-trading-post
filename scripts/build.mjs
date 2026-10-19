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

// ── 保留上一版已发布的哈希文件 ─────────────────────────────────
// 旧链接在 CDN 上可能还有人访问，重建时不能凭空让它们 404。
const retained = {};
try {
  const previous = JSON.parse(readFileSync(resolve(root, 'dist/release-manifest.json'), 'utf8'));
  const items = previous.version === VERSION
    ? Object.values(previous.previousFiles || previous.retained || {})
    : Object.values(previous.files || {}).filter(i => /\.[0-9a-f]{12}\./.test(i.path))
        .concat(Object.values(previous.previousFiles || previous.retained || {}));
  for (const item of items) {
    const file = resolve(root, 'dist', item.path);
    if (existsSync(file)) retained[item.path] = {bytes: readFileSync(file), sha256: item.sha256};
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const files = {}, aliases = {};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

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

function walk(dir) {
  if (!existsSync(resolve(root, dir))) return [];
  return readdirSync(resolve(root, dir), {withFileTypes: true})
    .flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
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
  previousFiles[path] = {path, sha256: item.sha256, bytes: item.bytes.length};
  if (Object.values(files).some(f => f.path === path)) continue;
  if (sha(item.bytes) !== item.sha256) throw new Error('Corrupt retained resource: ' + path);
  mkdirSync(resolve(root, 'dist', dirname(path)), {recursive: true});
  writeFileSync(resolve(root, 'dist', path), item.bytes);
  retainedManifest[path] = {path, sha256: item.sha256, bytes: item.bytes.length};
}

writeFileSync(resolve(root, 'dist/release-manifest.json'),
  JSON.stringify({version: VERSION, files, aliases, retained: retainedManifest, previousFiles}, null, 2) + '\n');

const pageGzip = PAGES.reduce((sum, p) => sum + files[p].gzipBytes, 0);
console.log(`Built ${VERSION}; page gzip: ${pageGzip} bytes; ${Object.keys(files).length} files.`);
