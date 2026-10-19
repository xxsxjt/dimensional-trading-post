# 交接文档 — dimensional-trading-post

最后更新：2026-10-19

## 一句话

**界门交易行** —— 在平行世界之间经营交易行的网页游戏。已从 `xxsx-web-games` 仓库独立出来。

## 路径

```
D:\Users\xxsx\orca\workspaces\dimensional-trading-post
├── game/          ← 当前工作树（split-game 分支）
└── （根目录也是同一套文件，main 分支）
```

远程：`https://github.com/xxsxjt/dimensional-trading-post`
分支：`main`（合并后的完整版）、`split-game`（分离过程）

## 技术栈

- Vanilla JS + CSS，无框架
- 单 HTML 入口 `wasteland.html`
- 构建脚本 `scripts/build.mjs`（自研，输出哈希文件名 + sha256 清单）
- 测试 `tests/wasteland-shop.cjs`（node vm + 假 DOM）

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | V1（与游戏厅的 V62 分开） |
| 测试 | 全绿 |
| 内容 | 228 个物品 / 20 道配方 / 6 台机器 / 9 个角色 |
| 美术 | 258 张（228 物品 + 6 机器 + 4 设施 + 9 立绘 + 10 世界 + 1 UI） |
| 世界 | 2 个开放，9 个标注开发中（场景图已备好） |

## 常用命令

```sh
npm run dev       # 开发服务器
npm test          # 跑测试
npm run build     # 构建到 dist/

npm run art:manifest   # 生成待画清单
npm run art:generate   # 批量出图（需 AGCPro 密钥）
npm run art:index      # 重建美术索引
```

## 已知事项

1. **存档键仍是 `xxsxWastelandShopV1`** —— 和游戏厅里的旧版共用。玩家从旧入口带过来的存档能直接读。
2. **游戏厅那边还留着旧副本** —— `xxsx-web-games` 仓库的 `wasteland.html` 与 `src/wasteland-*.js` 仍在，
   入口通过 `DIMENSION_GAME_URL` 常量跳转（留空则回退到旧副本）。等独立部署稳定后再删。
3. **`cornetfish/` 目录** —— 旧 worktree 残留，当前会话占用中，删除会失败。新会话可直接删。

## 开发约定

- 保持 Vanilla JS 无框架
- 新增物品必须同时接入获取渠道（访客带货 / 派遣 / 生产 / 订购），否则等于死数据
- 改 `src/` 后必须 `npm run build`，否则静态校验会报 stale source
- 美术缺图时自动退回 emoji，所以可以分批生成
