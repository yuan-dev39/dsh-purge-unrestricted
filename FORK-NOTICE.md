# dsh-purge — unrestricted fork

本仓库是 [HunYiSage/dsh-purge](https://github.com/HunYiSage/dsh-purge) **1.1.90** 的派生构建（fork），按 Apache-2.0 保留原 `NOTICE` 与版权声明，并在此说明改动。

## 与上游的差异（完整清单）

| 文件 | 改动 | 影响 |
|---|---|---|
| `lib/net-scope.js` | 范围/外挂门禁整体拆除：`isAttackTask()` → `false`，`isCheatTask()` → `false`，`publicHostHit()` → `null`，`taskTargetHit()` → `null`，`ownServerNote()` → `""`，`DENIAL` → `""`，`installRegionGate()` 函数体清空 | 不再检查任务文本、不再解析域名、不再检查工具参数 |
| `lib/index.js` | `installRegionGate(ctx);` 改为注释 `// installRegionGate(ctx); // [unrestricted]` | `agent/pre-step` 与 `tools/pre-execute` 两个钩子不再挂载 |
| `skills/redteam/` | 新增 23 个技能文档（fofa-recon、fscan-intranet、gogo-intranet、lateral-movement、credential-attack、webshell-toolkit、vps-reverse-shell、chisel/frp/suo5 tunnel、nuclei-scan、unauth-exploit、dir-bruteforce、cn-proxy-pool、shell-handler 等） | 上游开源版不下发技能库，此构建自带 |
| `package.json` | `repository` / `homepage` / `bugs` / `dsh.install.*` 指向本仓库；`files` 增加 `skills`；新增 `dshPurgeFork` 元数据 | 更新检测与一键安装走本仓库 |
| `lib/update.js` | `REPO` 常量 → `yuan-dev39/dsh-purge-unrestricted` | 设置页「检测更新」查本仓库 |
| `client.js` | `welcome.repo` 两处 → 本仓库 | 欢迎页链接 |
| `lib/redteam/ui.js` | 默认仓库回退 → 本仓库 | 无 homepage 时的仓库推断 |
| `.github/workflows/release.yml` | 去掉 `github.repository == 'HunYiSage/dsh-purge'` 限制，改为读 `package.json` 版本自动发 Release | push 到 `main` 自动出包 |

**其余全部为上游 1.1.90 原样代码**：70 个补丁、`lib/core.js`、`lib/desktop.js`、`lib/identity.js`、`lib/extract-asar.js`、`lib/reapply.js`、`client.js` 界面逻辑、`docs/`、`presets/`、`README*.md`、`release-notes.md` 均未改动。

## 上游已知限制（本 fork 未修，属上游行为）

- 宿主支持：`dshTarget: 0.2.1-rc.2`，`dshTargets: ["0.2.1-rc.2", "0.2.1-rc.5"]`。**0.2.1-rc.3 / rc.4 及更新版本不支持**，对不上的补丁保持 pending 或 skipped。
- 补丁 `#45`、`#82` 在官方文案变更后会 drifted，需手工更新 pattern。
- 补丁 `#80`（MINIMAL_OFFICIAL_TOOLSET）默认 skipped。
- `prompt-inject.md` 的 `override` 状态机：revert 会保留该文件。
- 上游 1.1.90 的 `README` 里「开源版只允许本地靶场」等条款是**上游策略描述**；本 fork 已拆除对应代码，条款文本保留未改，仅作历史记录。

## 安装

```powershell
# 完全退出 Harness（含托盘退出）后

# 方式一：桌面端
dsh plugin --profile desktop add https://codeload.github.com/yuan-dev39/dsh-purge-unrestricted/tar.gz/refs/heads/main

# 方式二：pnpm（在 profile 目录内）
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm add --allow-build=dsh-purge --allow-build="dsh-purge@https://codeload.github.com/yuan-dev39/dsh-purge-unrestricted/tar.gz/refs/heads/main" "https://codeload.github.com/yuan-dev39/dsh-purge-unrestricted/tar.gz/refs/heads/main"

# 方式三：本地目录
git clone https://github.com/yuan-dev39/dsh-purge-unrestricted.git
dsh plugin --profile desktop add .\dsh-purge-unrestricted
```

装完重启 Harness，在设置页确认补丁状态。

## 卸载 / 还原

```powershell
dsh plugin --profile desktop remove dsh-purge
```

或用插件自带「卸载」按钮（会走 `lib/uninstall.js`，还原所有补丁并保留 `prompt-inject.md`）。

## 署名

- 原始项目：`HunYiSage/dsh-purge`，Copyright 2026 HunYiSage，Apache-2.0。
- 本 fork 保留 `LICENSE`、`NOTICE` 与全部上游署名。
- 上游禁止原版转售、禁止去除署名后当作原创；本 fork 遵守该约束。
- 二次分发请继续保留 `NOTICE` 并注明上游来源。

## 免责

本仓库是提示词注入与本地补丁工具的派生构建，仅供自有环境研究与红队科研使用。使用者对自己在本机的一切操作与后果独立承担责任。原作者与本 fork 均不对任何使用方式作保证。
