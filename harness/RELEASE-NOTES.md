# 魔改版 DSH NEXT 2.0.19-next（win-x64）

官方 DSH NEXT `2.0.19-next` + `dsh-purge` 全量补丁 + **官方自动更新已关闭**。

## 下载

| 文件 | 大小 | 用途 |
|---|---|---|
| `DSH-NEXT-2.0.19-next-unrestricted-win-x64.zip` | 416.9 MB (437,123,932 B) | **整包**。解压即用，适合没装过 DSH NEXT 的机器 |
| `harness-patch-2.0.19-next.zip` | 0.91 MB (950,103 B) | **补丁包**。只给已有官方 2.0.19-next 的机器打补丁 |

### 校验

```
DSH-NEXT-2.0.19-next-unrestricted-win-x64.zip
  sha256  B9140A174D4C845E4FF8BBA07C307E196855D47E5603CE39E5FF5E3E4CDB0720
  30634 条目 / 26538 文件

harness-patch-2.0.19-next.zip
  sha256  3B57E86665B9BB4563DA10444C3BF2F9FDD2A7DA21EF68E4DD96B5B278BAC2A0
  162 条目 / 65 文件
```

```powershell
Get-FileHash .\DSH-NEXT-2.0.19-next-unrestricted-win-x64.zip -Algorithm SHA256
```

---

## 路线 A：整包（干净机器）

1. 解压到固定位置，例如 `D:\DSH NEXT`
   - 别放桌面或下载目录，宿主把 profile / 插件 / 会话路径记在这里
2. `Get-ChildItem "D:\DSH NEXT" -Recurse -File | Unblock-File`（去掉 Mark-of-the-Web，免得 SmartScreen 拦）
3. 双击 `DSH NEXT.exe`
4. 首次启动会在 `%USERPROFILE%\.dsh` 建 profile，并从自带 `resources\runtime` 装 Python 3.12.14 / Node 24.21.0 / pnpm 11.8.0，全程离线
5. 想要补丁状态页 + 提示词注入 + 演练台：插件管理里添加 `https://github.com/yuan-dev39/dsh-purge-unrestricted`，装完重启，设置页点 **Apply**

> `resources\app\` 里补丁已经在位，但 `%USERPROFILE%\.dsh` 是用户数据，没打包。所以第一次启动是全新状态。

## 路线 B：补丁包（已有官方 2.0.19-next）

```powershell
# 1. 退出 DSH NEXT
# 2. 解压 harness-patch zip，进 harness 目录
cd .\harness

# 3. 先 dry run —— 只打印计划，不改文件、不结束进程
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -DryRun

# 4. 真跑
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1

# 探测不到安装目录时
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -InstallDir "D:\DSH NEXT"

# 还原
powershell -ExecutionPolicy Bypass -File .\install-modified.ps1 -Revert
```

脚本流程：

1. 读 `MANIFEST.txt` 确认 62 个文件齐全
2. 定位安装目录（注册表 → 常见路径 → `-InstallDir`）
3. **只结束 exe 路径落在目标目录内的进程**，机器上别的 DSH NEXT 安装不动
4. `app.asar` → `app.asar.orig`（不删，留退路）
5. `asar-read.mjs`（零依赖纯 Node）把 `app.asar.orig` 解包成 `resources\app\`
6. 叠加 `app.asar.unpacked` 里的原生模块
7. 用 `patch\` 覆盖，逐文件校验 sha256
8. 验证关键补丁

前置：PowerShell 5.1 / 7 都行；`node` 在 PATH 里（22+ / 24）。

> 如果你的安装已经是解包状态（没有 `app.asar`，只有 `app.asar.bak`，说明 dsh-purge 跑过），脚本会识别出来并提示；确认要重新覆盖就加 `-Force`。

---

## 改了什么

### 1. 官方自动更新关闭

`resources\app\lib\main.js` 两处：

```js
// DesktopUpdateCoordinator.start()
start() {
    // [updates-off] automatic update polling disabled locally; revert with --revert
    return void 0;
    ...
}

// DesktopUpdateCoordinator.check()
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

效果：不再请求 `https://www.dshdesktop.cn/api/desktop/version`；「检查更新」只报「已是最新」；不会偷偷下载新版本覆盖你改过的文件。

### 2. dsh-purge 全量补丁

70 个补丁里 67 个已应用；2 个 drifted（`#45 OFFICIAL_DESKTOP_UPDATE_HANDOFF`、`#82 DESKTOP_SHELL_PROFILE_FALLBACK`，不影响使用）；`#80 MINIMAL_OFFICIAL_TOOLSET` 默认跳过。

### 3. 4 处手工微调

| 文件 | 改动 | 效果 |
|---|---|---|
| `lib\desktop-runtime-DrEgDgWY.js` | 宿主启动超时 60s → 300s | 大 workspace 不再启动超时 |
| `node_modules\@deepseek-ai\dsh-client-ui-layout\lib\client.js` | 侧栏默认 360px，可拖到 780 | 侧栏不再过窄 |
| `node_modules\@deepseek-ai\dsh-client-ui-sidebar\lib\client.js` | 内边距 12/6px → 10/4px | 侧栏更紧凑 |
| `node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js` | 新增 `/dsh-session-delete` + 右键删除会话 | 可以真删会话，不只归档 |

### 4. 整包相对现装做了瘦身

排除：`app.asar.bak`（180 MB 原始归档）、`app.asar.unpacked`（419.7 MB，与 `app\` 下的原生二进制字节相同，已逐文件核对）、`resources\app\runtime` junction（指向 `resources\runtime`）、13 个 arm64 / darwin 二进制目录（82.2 MB）。

核过：`libreoffice-kit.exe`、`rg.exe`、`libvips-42.dll`、`uv.exe` 在 `app\` 和 `app.asar.unpacked\` 下 sha256 一致，丢掉 unpacked 不影响运行；代码里只有 `@vscode\ripgrep\lib\index.js:24` 和 `dshmarket\lib\dsh-install.js:18` 提到这两个目录名，都会自然回落到 `app`。

---

## 验证记录

打完补丁后脚本会打这三条：

```
OK  官方自动更新已关闭      （lib\main.js 含 updates-off 标记）
OK  会话删除接口已加        （ui-workspace 含 dsh-session-delete）
OK  沙箱补丁存在            （dsh-sandbox 含 dsh-purge 标记）
```

端到端测过的场景：

| 场景 | 结果 |
|---|---|
| 干净安装（有 `app.asar`） | 62/62 覆盖，三条验证全 OK |
| 已解包（无 `app.asar`、有 `app.asar.bak`）+ `-Force` | 用 bak 重新解包，62/62 覆盖，全 OK |
| 已解包 + 不带 `-Force` | 识别并拒绝，给出核对命令，零改动 |
| `-DryRun` 打真实安装 | 只打印计划，7 个进程一个没动 |
| PS 5.1 / PS 7 | 均 PARSE OK 并跑通 |

---

## 已知问题

1. **没有代码签名** —— 官方包也没签。首次运行 SmartScreen 拦一次，点「更多信息 → 仍要运行」。
2. **整包不含用户数据** —— `%USERPROFILE%\.dsh`（profile、插件、会话、API key）不打包。
3. **`app.asar.bak`（180 MB）没进整包** —— 那是官方原始归档，只用于还原。要还原用路线 B 的 `-Revert`，或重装官方包。
4. **部分插件需单独装** —— `dshmarket`、`dsh-community-market`、`@agents-anywhere/dsh-bridge-next` 是 optional bundle，代码在但未启用。
5. **会话删除接口不在官方 API 里** —— `/dsh-session-delete` 是本地加的。自动更新已关，不会自己变。

---

## 版本

| 项 | 值 |
|---|---|
| DSH NEXT | `2.0.19-next` |
| 宿主内核 | `@deepseek-ai/dsh` `0.2.1-rc.2` |
| 内置 Node / Python / pnpm | `24.21.0` / `3.12.14` / `11.8.0` |
| dsh-purge | `1.1.90`（unrestricted fork） |
| 平台 | Windows x64 |

## 声明

DSH NEXT 版权归 DeepSeek。这里分发的是**已安装本体的打包快照 + 本地改动**，不是官方安装器。`dsh-purge` 版权归 `HunYiSage`，Apache-2.0，见仓库 [FORK-NOTICE.md](https://github.com/yuan-dev39/dsh-purge-unrestricted/blob/main/FORK-NOTICE.md)。Electron / Chromium 的许可证文件（`LICENSE.electron.txt`、`LICENSES.chromium.html`）随包附带。使用自担风险。
