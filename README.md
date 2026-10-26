# dsh-mini-window

把 **DeepSeek Harness** 变成常驻屏幕的「音乐播放器式」小窗：右下角一个悬浮球，
点一下就让 Harness 主窗口缩成置顶小窗——切到任何应用、任何全屏窗口，它都浮在最上层；
小窗里有输入框，消息直接进当前会话，模型的回复实时显示在里面。

```
┌─ 屏幕右下角 ────────────────┐
│  DSH 小窗            ✕      │
│  你                          │
│  帮我看下这个报错            │
│  模型 · 生成中…              │
│  这个报错是……                │
│  ┌────────────────────────┐  │
│  │ 给小窗发消息…           │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
        ●  ← 悬浮球（入口）
```

## 特性

- **悬浮球入口**：常驻在 Harness 页面上，可拖动、位置记忆。
  - 单击 = 开关「屏幕级小窗」（窗口置顶 + 缩到右下角）
  - 右键 = 开关「页内小窗」（不动窗口的轻量形态）
- **屏幕级小窗**：通过 Win32 `SetWindowPos` 给 Harness 主窗口加 `HWND_TOPMOST`，
  真正的操作系统级置顶，切到浏览器、编辑器、全屏视频都盖不住它；再点一次球恢复原尺寸。
- **同时给出页内小窗**：可拖动、右下角缩放、一键收成标题条，适合不想动窗口的时候。
- **输入直通当前会话**：走 `conversation.composer.dock` 的 `inputActions`
  （`setDraft` + `submit`），和主界面输入框是同一条通道。
- **回复实时同步**：订阅 Chat 快照，取最后一条用户消息与最后一条助手文本块，流式刷新。
- **跟随主题与语言**：颜色只用 `--dsw-alias-*` token；文案走 dsh locale 服务（zh-CN / en）。

## 安装

### 方式 A：dsh CLI（推荐）

```bash
dsh plugin --profile desktop add github:gulijushi-svg/dsh-mini-window
```

然后重启 dsh 一次。

### 方式 B：手动安装（无需 CLI）

1. 把仓库放到任意目录，例如 `D:\plugins\dsh-mini-window`。
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的 `dependencies` 里加一行：

   ```json
   "dsh-mini-window": "file:D:/plugins/dsh-mini-window"
   ```

3. 在同一个文件的 `dsh.profile.bundles` 数组末尾加 `"dsh-mini-window"`。
4. 把整个目录复制进
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-mini-window`。
5. 重启 dsh。

> **改动生效范围**：`client.js`（浏览器半边）刷新页面即生效；
> `index.js`（Host 半边）与 `cordis.patch.yml` 需要重启 dsh。
> `restart-dsh.cmd` 是一个现成的重启脚本。

## 使用

| 操作 | 效果 |
| --- | --- |
| 单击悬浮球 | 进入 / 退出屏幕级小窗（置顶，右下角 560×640） |
| 右键悬浮球 | 进入 / 退出页内小窗 |
| 拖动悬浮球 | 换位置（自动记住） |
| 小窗输入框回车 | 发送（Shift+Enter 换行） |

小窗形态下会自动隐藏 Harness 顶部菜单条，把空间留给对话与输入。

## 原理

```
浏览器半边 client.js
  ├─ shell.overlay / mini-window.launcher → 悬浮球（常驻入口）
  ├─ shell.overlay / mini-window.inline   → 页内小窗
  ├─ shell.overlay / mini-window.toast    → 轻提示
  └─ conversation.composer.dock / .bridge → 会话桥：sessionId + inputActions + 最新消息

点击悬浮球
  └─ POST /api/mini-window/state { mode: 'enter' | 'exit' }
        ↓
Host 半边 index.js
  ├─ dsh webServer 路由 `/api/mini-window`（同源，自定义 dsh-app:// 协议下不会撞跨源）
  └─ 兜底回环端口 127.0.0.1:19731
        ↓
scripts/win-mini-window.ps1
  └─ FindMainWindow + SetWindowPos(HWND_TOPMOST) / 恢复原 rect
```

**为什么不用 Document Picture-in-Picture？** 实测在 Electron 壳里，
`documentPictureInPicture.requestWindow()` 虽然能创建窗口，但那个窗口被合成进 Harness
主窗口内部（命中测试返回的顶层窗口仍是主窗口），切到别的应用就被盖住——
跨应用常驻必须动原生窗口，这才引出了 Host 半边的 Win32 方案。

桥的存在原因：`shell.overlay` 是 **root 作用域**，拿不到会话级 props；
所以用一个注册在 `conversation.composer.dock` 的空组件把会话能力发布到模块级 store，
浮层再从这里读。

## 兼容性

- **Windows**：完整功能（窗口控制走 Win32 / `user32.dll`）。
- **其它平台**：页内小窗形态可用；屏幕级小窗的 Host 调用会失败并给出提示。
- 实测环境：DeepSeek Harness 桌面版（Electron 44，Windows，150% 缩放）。
- 若 Harness 主窗口带最小尺寸约束，小窗会按**实际**尺寸重新贴右下角，不会越出屏幕。

## 目录结构

```
dsh-mini-window/
├─ package.json            # dsh.bundle.patch + dsh.client 声明
├─ cordis.patch.yml        # bundle patch：插入 Host 插件
├─ index.js                # Host 半边：控制端点 + 调用 Win32 脚本
├─ client.js               # 浏览器半边：浮层、小窗、会话桥
├─ scripts/
│  └─ win-mini-window.ps1  # Win32：置顶 / 尺寸 / 还原（UTF-8 BOM）
├─ locale/{zh,en}.json     # 插件元信息文案
├─ icon.svg
└─ README.md
```

## 已知限制

- 小窗模式下隐藏的是 dsh 自己的顶部菜单条；窗口的最小化 / 关闭按钮仍由壳提供。
- 屏幕级小窗会改变主窗口的尺寸与层级 —— 它就是把主窗口变成小窗，不是另开一个窗口，
  所以退出时依赖保存的原 `rect`（脚本写在 `%TEMP%\dsh-mini-window-state.json`）。
- `scripts/win-mini-window.ps1` 必须保持 **UTF-8 with BOM**：
  Windows PowerShell 5.1 会按 ANSI 读取无 BOM 的 UTF-8，中文注释会撑坏语法。

## 仓库

<https://github.com/gulijushi-svg/dsh-mini-window>

## License

MIT