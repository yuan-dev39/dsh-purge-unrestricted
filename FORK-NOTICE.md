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
| `lib/redteam/ui.js` | 默认仓库回退 → 本仓库（该函数已于 2026-11-18 随「检查更新」功能一并删除） | 无 homepage 时的仓库推断 |
| `.github/workflows/release.yml` | 去掉 `github.repository == 'HunYiSage/dsh-purge'` 限制，改为读 `package.json` 版本自动发 Release | push 到 `main` 自动出包 |

### 2026-11-18 追加修复（本仓库 main 领先 `v1.1.90` 标签）

| 文件 | 改动 | 影响 |
|---|---|---|
| `lib/index.js` | 删除 `/dsh-purge/update` 路由（GET 查询 + POST 应用/切通道）、启动期 `autoUpdateIfNeeded()` 调用；状态载荷去掉 `update` 字段 | 插件不再向 npm / GitHub 查询版本，也不存在一键更新的 HTTP 入口 |
| `client.js` | `renderEdition()` 直接 `return null`；`checkUpdate` / `postUpdate` / `doUpdate` / `changeChannel` / `switchSelected` 改为空实现；移除 `/dsh-purge/update` 的请求超时特例 | 设置页只剩「当前版本」，没有「检查更新 / 有新版本 / 一键更新 / 切换通道」按钮 |
| `lib/redteam/client.js` | `VersionBar()` 函数体改为 `return null` | 演练台右上角不再显示版本条与更新按钮 |
| `lib/redteam/ui.js` | `handleUpdateOp` 只接受 `op: 'version'`；`'version'` 分支不再调用 `checkLatest()`；删除 `updateCheck` / `updateApply` 分支与 `checkLatest`、`checkLatestFromGithub`、`fetchJsonFromGithub`、`githubRepoOf`、`isPrereleaseName` 五个已无调用方的函数 | 更新类 op 即使被构造也不再触网 |
| `lib/core.js` | surface 判定不再依赖 `process.execPath`（CLI 跑 apply 时 `desktop` 目标被误判成 `na` 的老问题）；`#28` 重定向目标修正；`suspect_baks` 守卫；启动自愈不覆盖前端 `client.js`（#63） | 桌面壳补丁在 CLI 与桌面两条路径下都能命中，坏 bak 不再被当真原件还原 |
| `lib/surface.js` | 新增目标存在性/宿主判定辅助 | 配合 `lib/core.js` 的 surface 修正 |
| `bin/dsh-purge.js` | `--status` 输出按 surface 归并、`na` 与 `skipped` 分开统计 | CLI 计数与面板一致（桌面 71 行 = 70 applied + 1 skipped） |

### 2026-11-19 第四波修复：status 端点性能

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `lib/core.js` | `gatherState()` 加 1.5 s 结果缓存 + `gatherState({fresh:true})` 旁路 + `invalidateGatherState()` 导出；原实现改名 `gatherStateUncached()` | 每次调用要把 86 条 patch 的宿主文件全读一遍：热态 844 ms，面板打开时 `/dsh-purge/status` 单次 171~248 ms、并发 10 次 1822 ms。缓存后热态 0 ms |
| `lib/index.js` | apply / revert 两处 HTTP 路由与 `purge_apply` / `purge_revert` 两个工具，写前 `invalidateGatherState()` + `gatherState({fresh:true})` | 写操作必须看到写前的真实状态，否则会拿 1.5 s 内的旧快照算"已应用"而跳过该打的补丁 |

## 2026-11-19 第三波修复：接口语义统一 + 命令/工具兜底

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `lib/index.js` | 14 处内联 405 + `methodNotAllowed()` 全部改成 JSON 体（`{ok:false, error:"只支持 GET"}`），带 `content-type: application/json` | 原来 `writeHead(405); response.end()` 是空体，前端 `apiJson` 解析失败只能报 `405 non-json: `，用户看不到任何原因 |
| `lib/index.js` | `/rewind` 命令 handler 的 `analyzeRewind` / `applyRewind` 包 try/catch，异常转成 `{kind:"error", text:"回退不可用：…"}` | 命令 handler 抛异常会冒到宿主命令层，整条命令直接崩 |
| `lib/index.js` | `purge_status` / `purge_apply` / `purge_revert` 三个工具 `execute()` 包 try/catch，异常转成 `{text:"ERROR: …"}` | 工具注册表里抛异常会把整次模型工具调用打成红色失败，模型拿不到任何上下文 |

## 2026-11-18 第二波修复：补回「继续」入口（上游 1.1.90 缺失）

| 文件 | 改动 | 影响 |
|---|---|---|
| `lib/continue-http.js` | **新增**。`continueHttpHandler(getRuntime)` 处理 `/dsh-purge/continue` 的四个端点：`GET ?sessionId=`（状态）、`POST`（发一条「继续」，`{force:true}` 跳过新消息检查）、`GET /settings`、`POST /settings`；未知后缀 404、其它方法 405、运行时未就绪 503、请求体上限 256 KB | 面板的「继续」按钮与设置区终于有后端可打 |
| `lib/index.js` | 新增 `import { continueHttpHandler }`；`apply()` 里把 `continueRuntime` 挂到 `ctx.__dshPurgeContinue`；`installWebServer` 里注册 `{kind:"prefix", path:"/dsh-purge/continue"}` 路由 | 上游只有客户端代码没有宿主路由，按钮必 404 |
| `lib/continue-retry.js` | ① `mergeConfig` 不再无脑强制 `autoContinue:false`（原来面板勾选自动续跑永远存不下来）；② 新增 `saveSettings(dshHome, raw)` 原子写 `dsh-purge/continue-retry.json`；③ 新增 `agentOf(ctx, sessionId)` 安全取 agent；④ tracker 增加 `peek()`（只读，不占名额）、`bumpContinue()`、`tagManual()` / `manualTaken()`；⑤ `statusOf` 加 900 ms 结果缓存（面板 1.2 s 轮询，避免每轮都走一遍 turn 检查），并带「事件数 + 最后 turn/end seq + agent 状态 + 关键配置」指纹，任何一项变化立刻重算（只靠 TTL 会让上一轮刚失败时按钮 900 ms 内不出来）；⑥ `force` 续跑不占 `continueMax` 名额，但会在该 seq 上打标记，自动续跑不会对同一轮重复发 | 设置能存、状态能刷、续跑计数不再漏、手动续不重复发 |
| `client.js` | ① 恢复设置区的 `h(ContinueRetrySection, null)`（之前被注释掉）；② 新增 `ContinueMount`，只在 `canContinue` 为真时把「继续」按钮挂进输入框左侧那一排，和「撤销上一步」并排；③ 1.5 s 轮询里按关键字段比对后再 `setState`，状态没变不重渲染 | 按钮真正出现，不该出现时不占位，轮询不抖 |
| `lib/continue-retry.js` 回退读盘 | 新增 `eventsOfSession(ctx, sessionId)`：agent 不在（宿主刚起、面板重连）时回退到 `sessions` / `sessionController` 读已落盘事件；`statusOf` 改为 async 并增加 `hasSession` 字段 | 「上一轮失败了」这个事实在无活动 agent 时也能被看到，而不是一律报 found:false |
| `lib/continue-http.js` | `status` 分支加 `await` + `try/catch` | 改成 async 后不加 await 会重新退化成 `{}` 空对象 |

**其余为上游 1.1.90 原样代码**：86 条补丁定义、`lib/desktop.js`、`lib/identity.js`、`lib/extract-asar.js`、`lib/reapply.js`、`docs/`、`presets/`、`skills/`、`README*.md`、`release-notes.md` 未改动。

> 说明：`lib/update.js` 仍保留上游实现（其 `REPO` 常量指向本仓库），但已无任何调用方；保留是为了不改变 `localVersion()` / `pluginRoot()` 的行为。

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
