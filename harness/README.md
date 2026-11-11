# 魔改版 DSH NEXT 安装说明

官方 DSH NEXT **2.0.19-next** + `dsh-purge` 全部补丁 + **官方自动更新已关闭**。

两种装法，按自己的情况选：

| 方式 | 体积 | 适用 | 步骤 |
|---|---|---|---|
| **A. 整包（推荐新手）** | ~1.05 GB | 干净机器，没装过 DSH NEXT | 下载 zip → 解压 → 双击 `DSH NEXT.exe` |
| **B. 打补丁（推荐老用户）** | ~3 MB | 已经装了官方 DSH NEXT 2.0.19-next | 跑一个 PowerShell 脚本 |

---

## 方式 A：整包解压即用

### 1. 下载

从 Release 页下载：

```
DSH-NEXT-2.0.19-next-unrestricted-win-x64.zip   约 1.05 GB
```

校验（可选，但建议）：

```powershell
Get-FileHash .\DSH-NEXT-2.0.19-next-unrestricted-win-x64.zip -Algorithm SHA256
# 对比 Release 说明里公布的 sha256
```

### 2. 解压

解压到一个**固定位置**，例如 `D:\DSH NEXT` 或 `C:\Users\<你>\AppData\Local\Programs\DSH NEXT`。

> ⚠️ 不要解压到桌面、下载目录、或任何会被清理的地方。桌面端的 profile、插件、会话都记在这个路径上，移动位置会导致宿主找不到自己的 runtime。

### 3. 首次启动

双击 `DSH NEXT.exe`。

第一次启动会：
- 在 `%USERPROFILE%\.dsh` 建 profile
- 从 `resources\runtime` 里把 Python 3.12 / Node 24.21 / pnpm 11.8 装好（内置，不联网）
- 起本地 webserver

等窗口出来就行，不用做别的。

### 4. 建议做的两件事

**（a）关掉 Windows 的「移动/删除阻止」**

从网上下载的 zip 解压出来的 exe 会被打上 Mark-of-the-Web，可能弹 SmartScreen。要么在文件属性里点「解除锁定」，要么：

```powershell
Get-ChildItem "D:\DSH NEXT" -Recurse -File | Unblock-File
```

**（b）装一份 dsh-purge**

整包里 `resources\app\` 已经带了补丁，但 `%USERPROFILE%\.dsh\profiles\` 是空的（那是用户数据，不该打包）。所以：

1. 打开 DSH NEXT
2. 插件管理里添加：`https://github.com/yuan-dev39/dsh-purge-unrestricted`
3. 装完重启，进设置页点 **Apply**

这样补丁状态、提示词注入、演练台才会全部就位。

---

## 方式 B：给已有的官方安装打补丁

已经装了官方 DSH NEXT 2.0.19-next 的话，只下这 3 MB 就够。

### 1. 下载 patch 包

从 Release 页下载：

```
harness-patch-2.0.19-next.zip   约 3 MB
```

解压后会看到：

```
harness/
├── install-modified.ps1     ← 主脚本（PS 5.1 / 7 通用）
├── asar-read.mjs            ← 零依赖 asar 解包器
├── MANIFEST.txt             ← 62 个文件的 sha256 + 大小 + 相对路径
├── README.md                ← 本文件
└── patch/                   ← 62 个改版后的文件，路径与 resources\app\ 一致
    ├── lib/
    ├── node_modules/
    └── ...
```

### 2. 关掉 DSH NEXT

托盘图标右键退出，任务管理器里确认没有 `DSH NEXT.exe` 残留。

脚本只会结束**可执行文件就在目标安装目录里**的进程，机器上别的 DSH NEXT 安装不会被动。但先手动关更稳。

### 3. 先 dry run

```powershell
cd .\harness
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -DryRun
```

只打印将要做的事，不改任何文件、不结束任何进程。确认路径对了再往下。

### 4. 真跑

```powershell
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1
```

自动探测安装目录。探测不到就手动指定：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -InstallDir "D:\DSH NEXT"
```

脚本做的事：

1. 读 `MANIFEST.txt`，确认 62 个文件都在
2. 找安装目录（注册表 → 常见路径 → `-InstallDir`）
3. 结束目标目录内的 `DSH NEXT.exe`（按 exe 路径过滤，**不碰别的安装**）
4. 把 `resources\app.asar` 改名成 `app.asar.orig`（**不删，留退路**）
5. 用内置的纯 Node asar reader（`asar-read.mjs`，零依赖）把 `app.asar.orig` 解包成 `resources\app\`
6. 把 `app.asar.unpacked` 里的原生模块叠加进去
7. 用 `patch\` 下的文件覆盖，逐个校验 sha256
8. 验证关键补丁生效

### 5. 还原

```powershell
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -Revert
```

会删掉 `resources\app\`、把 `app.asar.orig` 改回 `app.asar`，回到官方原样。

### 前置依赖

- PowerShell 5.1（Win10/11 自带）或 PowerShell 7 都可以，脚本两个版本都测过
- `node` 在 PATH 里（Node 22+ / 24）。没有的话装一个，或把 DSH NEXT 自带的 node 加进 PATH

---

## 这个版本改了什么

### 1. 官方自动更新已关闭 ⭐

这是你说的「去掉更新」。两处改动都在 `resources\app\lib\main.js`：

```js
// DesktopUpdateCoordinator.start() —— 启动时的后台轮询直接返回
start() {
    // [updates-off] automatic update polling disabled locally; revert with --revert
    return void 0;
    if (!this.options.packaged || this.timer || this.disposed) return;
    ...
}

// DesktopUpdateCoordinator.check() —— 手动检查更新也不发请求
check(background = false) {
    // [updates-off] never contact the update service; report the running build as current
    if (!this.options.packaged) {
        this.set({ phase: "error", error: "development" });
        return Promise.resolve();
    }
    if (this.state.phase !== "checking") this.set({ phase: "current", version: this.state.version });
    return Promise.resolve();
    ...
}
```

效果：
- 不再向 `https://www.dshdesktop.cn/api/desktop/version` 发请求
- 托盘/菜单里的「检查更新」点了只会显示「已是最新」
- 不会偷偷下载新版本把你改过的文件覆盖掉

### 2. dsh-purge 全量补丁（58 处）

70 个补丁里 67 个已应用、2 个 drifted（不影响使用）、1 个（`#80` 极简工具集）默认跳过。

### 3. 4 处手工微调

| 文件 | 改动 | 效果 |
|---|---|---|
| `lib\desktop-runtime-DrEgDgWY.js` | 宿主启动超时 `60s` → `300s` | 大 workspace 不再启动超时 |
| `node_modules\@deepseek-ai\dsh-client-ui-layout\lib\client.js` | 侧栏默认宽度 → `360px`，可拖到 `780` | 侧栏不再过窄 |
| `node_modules\@deepseek-ai\dsh-client-ui-sidebar\lib\client.js` | 内边距 `12px/6px` → `10px/4px` | 侧栏更紧凑 |
| `node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js` | 新增 `/dsh-session-delete` 接口 + 右键「删除会话」 | 可以真删会话，不只是归档 |

---

## 文件清单

`MANIFEST.txt` 每行格式：

```
<sha256>  <bytes>  <相对 resources/app 的路径>
```

62 行。想核对自己机器上的文件：

```powershell
Get-Content .\harness\MANIFEST.txt | ForEach-Object {
    $h,$sz,$rel = $_ -split '\s+',3
    $fp = Join-Path "D:\DSH NEXT\resources\app" ($rel -replace '/','\')
    if (-not (Test-Path $fp)) { "MISSING $rel"; return }
    $a = (Get-FileHash $fp -Algorithm SHA256).Hash
    if ($a -ne $h) { "DIFF    $rel" }
}
```

---

## 已知问题

**1. 没有代码签名**

官方包也没签。首次运行 SmartScreen 会拦一次，点「更多信息 → 仍要运行」。

**2. 整包里没有你的用户数据**

`%USERPROFILE%\.dsh`（profile、插件、会话、API key）不打包。整包只带 `resources\app\` 的程序本体。所以第一次启动是全新状态。

**3. `resources\app.asar.bak`（180 MB）没打进去**

那是官方原始 asar，只用于还原。要还原请用方式 B 的 `-Revert`，或者重新装一次官方包。

**4. 部分插件需要单独装**

`dshmarket`、`dsh-community-market`、`@agents-anywhere/dsh-bridge-next` 是 optional bundle，程序里有代码但没启用。需要的话在插件管理里开。

**5. 会话删除接口不在官方 API 里**

`/dsh-session-delete` 是本地加的。如果以后官方升级并改动了 webserver 路由表，这个接口可能失效（但你已经关了自动更新，所以不会自己变）。

---

## 版本信息

| 项 | 值 |
|---|---|
| DSH NEXT | `2.0.19-next` |
| 宿主内核 | `@deepseek-ai/dsh` `0.2.1-rc.2` |
| Electron | 见 `DSH NEXT.exe` 版本 |
| 内置 Node | `24.21.0` |
| 内置 Python | `3.12.14` |
| 内置 pnpm | `11.8.0` |
| dsh-purge | `1.1.90`（unrestricted fork） |
| 平台 | Windows x64 |

---

## 出处与声明

- DSH NEXT 是 DeepSeek 的软件，版权归其所有。本仓库分发的是**已安装本体的打包快照 + 本地改动**，不是官方安装器。
- `dsh-purge` 版权归 `HunYiSage`，Apache-2.0。见 [FORK-NOTICE.md](../FORK-NOTICE.md)。
- 使用自担风险。
