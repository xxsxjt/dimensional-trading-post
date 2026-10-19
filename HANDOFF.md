# 交接文档 — dimensional-trading-post

最后更新：2026-10-19 ｜ 维护者：pi-workspace 分支

## 一句话

**时空交易行** —— 跨平行世界做买卖的网页游戏。

## 路径

```
D:\Users\xxsx\orca\workspaces\dimensional-trading-post
```

Orca 项目 id：`repo:58925913-c52c-48fd-afe9-d0cb313ee768`（worktree: cornetfish）

## 结构

```
dimensional-trading-post/
├── README.md
├── cornetfish/      ← 当前工作树
└── dtp-dev/         ← 开发树
```

## 游戏设定（README）

十个平行世界：
- 核废土、瘟疫废土、AI 末日
- 仙侠宗门、凡人市集
- 蒸汽朋克帝国、赛博法师城、中世纪王国
- 星际前哨、远古帝国集市

## 技术栈

- Vanilla JS + CSS，无框架
- Vite 做 dev/build
- 单 HTML 入口

## 当前状态

| 项 | 值 |
|---|---|
| HEAD | `03a2f6f` Initial commit: project setup（2026-10-14）|
| dirty | **2 项** |
| 分支 | main |

**状态判断**：项目处于**初始搭建阶段**——只有一个 initial commit，还没有实际玩法实现。

## 已知问题

1. **两个工作树**（`cornetfish/` 和 `dtp-dev/`），需确认哪个是当前主用
2. **2 项未提交**，需要检查是什么
3. 项目刚开始，没有测试、没有构建产物

## 迁移历史

2026-10-19 之前位置未变。本次整理只做了只读检查，**没有改动任何文件**。

## 开工前必读

1. 先确认 `cornetfish/` 和 `dtp-dev/` 的关系（哪个是主线）
2. 项目处于早期，架构决策还有很大空间
3. 保持 Vanilla JS 无框架的选型（README 明确）
