/* 界门交易行 · 构建保留策略回归
 *
 * 构建脚本的承诺（scripts/build.mjs 注释里写着的）：
 *   「旧链接在 CDN 上可能还有人访问，重建时不能凭空让它们 404」
 * 所以当源码改动产生新的哈希产物时，上一版的哈希产物必须仍然存在，
 * 并且要被 release-manifest.json 的 retained / previousFiles 记录下来。
 *
 * 原实现的分支是：
 *   previous.version === VERSION
 *     ? Object.values(previous.previousFiles || previous.retained || {})
 *     : Object.values(previous.files || {}).filter(哈希命名)...
 *
 * 也就是说 previous.files 那一支只在「版本号变了」时才走。
 * 同版本重建时，items 只来自 previousFiles / retained ——
 * 而全新 checkout 的这两项都是空的，于是保留逻辑等于没生效：
 * 旧哈希文件只是因为「build 从不删东西」而侥幸留在磁盘上，
 * 清单里没有任何记录，dist/ 无限膨胀，git 也把它们当成孤儿文件。
 *
 * 用法：node tests/build-retention.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const cp = require('node:child_process');
const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'dist', 'release-manifest.json');
const buildScript = path.join(root, 'scripts', 'build.mjs');
const shopPath = path.join(root, 'src', 'wasteland-shop.js');

const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const build = () => cp.execFileSync(process.execPath, [buildScript], {cwd: root, stdio: 'pipe'}).toString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const isShopHash = p => /^src\/wasteland-shop\.[0-9a-f]{12}\.js$/.test(p);

/* ── 1. 模拟全新 checkout：清单里的 retained/previousFiles 为空 ── */
const originalSource = fs.readFileSync(shopPath, 'utf8');
const originalManifest = readManifest();
const savedManifest = JSON.stringify(originalManifest, null, 2) + '\n';
let changedHash = null;
/* 测试过程会多产出哈希产物，收尾时要把它们清掉，不能给仓库留垃圾 */
const distSrcDir = path.join(root, 'dist', 'src');
const distSrcBefore = new Set(fs.readdirSync(distSrcDir));

try {
  const fresh = JSON.parse(savedManifest);
  fresh.retained = {};
  fresh.previousFiles = {};
  fs.writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + '\n');

  const beforeHashes = Object.values(fresh.files).map(f => f.path).filter(isShopHash);

  /* build 1：改源码 → 产生新哈希 */
  fs.writeFileSync(shopPath, originalSource + '\n// retention-probe\n');
  build();
  const probe = readManifest();
  changedHash = Object.values(probe.files)
    .map(f => f.path)
    .find(p => isShopHash(p) && beforeHashes.indexOf(p) === -1);
  assert.ok(changedHash, 'touching the source must produce a new hashed artifact');

  /* build 2：还原源码 → 旧哈希变成「上一版」，必须被保留并记录 */
  fs.writeFileSync(shopPath, originalSource);
  build();

  const manifest = readManifest();
  const retained = manifest.retained || {};
  const previousFiles = manifest.previousFiles || {};
  const retainedPaths = Object.keys(retained);
  const previousPaths = Object.keys(previousFiles);

  assert.ok(retainedPaths.length > 0,
    'a same-version rebuild must retain the previous version\'s hashed artifacts (retained is empty — ' +
    'the CDN promise in build.mjs is not being kept)');
  assert.ok(previousPaths.length > 0,
    'a same-version rebuild must list the previous version\'s hashed artifacts (previousFiles is empty)');

  /* 上一版必须仍在磁盘上，且内容哈希不变 */
  for (const p of retainedPaths) {
    const abs = path.join(root, 'dist', p);
    assert.ok(fs.existsSync(abs), 'retained artifact must still exist on disk: ' + p);
    assert.equal(sha(fs.readFileSync(abs)), retained[p].sha256,
      'retained artifact must still hash to its recorded sha256: ' + p);
  }

  /* previousFiles 只应记录「不是本次构建产物」的旧文件 */
  const currentPaths = Object.values(manifest.files).map(f => f.path);
  for (const p of previousPaths) {
    assert.ok(!currentPaths.includes(p),
      'previousFiles must not list files produced by the current build: ' + p);
    assert.ok(retainedPaths.includes(p),
      'every previousFiles entry must also be listed under retained: ' + p);
  }

  /* 清单里记录的每个哈希产物都必须在磁盘上（不能只记不落盘） */
  for (const p of retainedPaths) {
    assert.ok(fs.existsSync(path.join(root, 'dist', p)), 'missing on disk: ' + p);
  }

  console.log('PASS a same-version rebuild retains the previous version\'s hashed artifacts (' +
    retainedPaths.length + ' retained, ' + previousPaths.length + ' previousFiles), ' +
    'each still on disk with a matching sha256');
} finally {
  /* 收尾：还原源码与清单，清掉本次测试多产出的哈希产物，不给仓库留垃圾 */
  fs.writeFileSync(shopPath, originalSource);
  fs.writeFileSync(manifestPath, savedManifest);
  for (const name of fs.readdirSync(distSrcDir)) {
    if (!distSrcBefore.has(name)) fs.unlinkSync(path.join(distSrcDir, name));
  }
}
