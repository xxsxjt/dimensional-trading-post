/* 构建 · 孤儿哈希产物捞回回归
 *
 * scripts/build.mjs 承诺过一件事：
 *   「旧链接在 CDN 上可能还有人访问，重建时不能凭空让它们 404」
 *
 * 为了兑现这个承诺，构建脚本会扫一遍 dist/，
 * 把**清单没记、但磁盘上还在**的哈希产物补进 retained。
 *
 * 那段代码以前是坏的：
 *
 *   for (const dir of walk('dist')) {        // dir = 'dist/src/xxx.js'
 *     ...
 *     candidates.set(dir, {path: dir, ...}); // ← 键带着 'dist/' 前缀
 *   }
 *   for (const [path, item] of candidates) {
 *     const file = resolve(root, 'dist', path);
 *     // → resolve(root,'dist','dist/src/xxx.js') = 'dist/dist/src/xxx.js'
 *     if (!existsSync(file)) continue;       // ← 永远不存在，全部被丢掉
 *   }
 *
 * 也就是说：**这段「捞回孤儿」的逻辑从来没生效过**。
 * 每构建一次，源码一改、哈希文件名一变，
 * 旧的哈希产物就在磁盘上变成没人记录的孤儿 ——
 * dist/ 无限膨胀，清单里查不到，git 也只能当垃圾。
 *
 * 修法是剥掉 'dist/' 前缀，让键统一成相对 dist/ 根的 'src/xxx.js'。
 *
 * 用法：node tests/build-orphan-salvage.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const cp = require('node:child_process');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'dist', 'release-manifest.json');
const buildScript = path.join(root, 'scripts', 'build.mjs');
const distSrcDir = path.join(root, 'dist', 'src');

const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const build = () => cp.execFileSync(process.execPath, [buildScript], {cwd: root, stdio: 'pipe'}).toString();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/* 造一个哈希名合法、但清单里不存在的孤儿产物。
 * 名字里的 12 位十六进制必须是真的，否则构建脚本的
 * /\.[0-9a-f]{12}\./ 根本不会把它当哈希产物。 */
const ORPHAN_REL = 'src/wasteland-core.0123456789ab.js';
const ORPHAN_ABS = path.join(distSrcDir, 'wasteland-core.0123456789ab.js');
const ORPHAN_BODY = '/* orphan-salvage-probe */\n';

const savedManifest = fs.readFileSync(manifestPath, 'utf8');
const distSrcBefore = new Set(fs.readdirSync(distSrcDir));

try {
  /* ── 1. 清单里没有这个文件，磁盘上有 ──────────────────────── */
  fs.writeFileSync(ORPHAN_ABS, ORPHAN_BODY);
  const before = readManifest();
  assert.ok(!before.retained[ORPHAN_REL] && !before.previousFiles[ORPHAN_REL],
    'precondition: the orphan must not already be in the manifest');
  assert.ok(!before.files[ORPHAN_REL],
    'precondition: the orphan must not be a current build product');

  /* ── 2. 构建一次，它必须被捞回来 ─────────────────────────── */
  build();
  const after = readManifest();

  assert.ok(after.retained[ORPHAN_REL],
    'the orphaned hashed artifact must be salvaged into retained — ' +
    'the "old links must not 404" promise in build.mjs is not being kept');
  assert.ok(after.previousFiles[ORPHAN_REL],
    'a salvaged orphan must also be listed under previousFiles');
  assert.equal(after.retained[ORPHAN_REL].sha256, sha(Buffer.from(ORPHAN_BODY)),
    'the salvaged artifact must be recorded with its real sha256');
  assert.ok(fs.existsSync(path.join(root, 'dist', ORPHAN_REL)),
    'the salvaged artifact must still exist on disk');

  /* ── 3. 捞回来的东西不能被当成「本次构建产物」 ────────────── */
  const currentPaths = Object.values(after.files).map(f => f.path);
  assert.ok(!currentPaths.includes(ORPHAN_REL),
    'a salvaged orphan must not be listed as a current build product');

  /* ── 4. 再构建一次，它必须稳稳留在清单里 ─────────────────── */
  build();
  const after2 = readManifest();
  assert.ok(after2.retained[ORPHAN_REL],
    'a salvaged orphan must stay in the manifest across rebuilds');

  console.log('PASS an orphaned hashed artifact is salvaged into the manifest ' +
    '(retained + previousFiles), hashed correctly, and kept across rebuilds');
} finally {
  /* 收尾：还原清单，清掉探针文件，不给仓库留垃圾 */
  fs.writeFileSync(manifestPath, savedManifest);
  if (fs.existsSync(ORPHAN_ABS)) fs.unlinkSync(ORPHAN_ABS);
  for (const name of fs.readdirSync(distSrcDir)) {
    if (!distSrcBefore.has(name)) fs.unlinkSync(path.join(distSrcDir, name));
  }
}
