# dsh-computer-use-bg

**后台电脑操作插件，给你的 DeepSeek Harness。** 让 agent 打开网页、读页面、点按钮、填表单、翻页 —— 全程在一个**独立的 Chromium 实例**里完成，**不移动你的鼠标、不抢你的键盘、不抢你的前台窗口**。

你可以在它干活的同时继续打字、切窗口、看视频，互不干扰。

> 与现有 computer-use 插件的区别：那些插件把 `SendInput` 打到**你正在用的桌面**上（截图 → 移动真实光标 → 真实按键），所以操作时会接管屏幕、你一碰键盘它就得让位。这个插件把输入合成在**它自己的浏览器进程内部**（Chrome DevTools Protocol），你完全无感。

---

## 为什么能做到"后台"

| | 传统桌面 computer-use | 本插件 |
|---|---|---|
| 定位方式 | 截图 + 像素坐标 | DOM / 无障碍元素带 `ref` 编号 |
| 输入方式 | `SendInput` 真实鼠标键盘 | CDP `Input.dispatchMouseEvent` 在浏览器内合成 |
| 占用前台 | 是（会抢焦点） | 否 |
| 你在干嘛 | 必须停下来 | 照常用电脑 |
| 换分辨率/缩放 | 点偏了要重算 | 无关（不用像素猜） |
| 本地软件 GUI | 能 | **暂不支持**（见 Roadmap） |

## 安装

### 图形界面（推荐，Electron 的 `desktop` profile 只能这样装）

1. 打开 **DSH → 设置 → 插件 → 添加插件**
2. 填下面任意一种：
   - 本地路径（最快，改代码后重启即生效）：`F:\dsh-pkgs\dsh-computer-use-bg`
   - 仓库地址：`github:y123546/dsh-computer-use-bg`
3. 重启 DSH

### 命令行（仅限非 `desktop` profile）

```bash
dsh plugin --profile web add github:y123546/dsh-computer-use-bg
```

要求：Windows 10/11、**Node.js ≥ 22.19**（用到原生 `WebSocket` / `fetch`）、本机有 Edge 或 Chrome。

## 配置

在 profile 的 `cordis.patch.yml` 里给 `bg-computer-use` 条目加 `config`：

```yaml
- id: bg-computer-use
  config:
    port: 9333            # CDP 端口，被占用就换一个
    headless: false       # true = 完全无窗口
    width: 1440           # 视口宽（截图与坐标 1:1）
    height: 900
    browserPath: ''       # 留空自动探测 Edge/Chrome
    profileDir: ''        # 留空用 <DSH_HOME>/dsh-computer-use-bg/profile
    timeoutMs: 25000      # 冷启动等待上限
    enabled: true         # false = 一个工具都不注册（硬开关）
```

## 工具

| 工具 | 作用 |
|---|---|
| `computer_use_doctor` | 自检：Node 版本、浏览器路径、端口、profile、页面是否应答。**出问题先跑这个** |
| `browser_open` | 打开 URL，返回可交互元素清单 + 截图 |
| `browser_snapshot` | 重新读页面：元素 `ref`、标题、滚动位置；可选页面文字 |
| `browser_click` | 按 `ref` / 可见文字 / 坐标点击；文字命中多个时**列出来让你选，不猜** |
| `browser_type` | 输入文字（Unicode 直插，中文没问题），`submit` 回车提交 |
| `browser_key` | 按键 / 快捷键：`Enter`、`Tab`、`Esc`、`ctrl+a`、`PageDown` |
| `browser_scroll` | 滚动视口 |
| `browser_text` | 把页面读成纯文本（比截图省 token） |
| `browser_eval` | 在页面里跑 JS，读结构化数据（表格、内嵌 JSON） |
| `browser_close` | 关掉私有浏览器（profile 保留，下次复用） |

`ref` 编号每次快照都会重排 —— 页面变了就重新 `browser_snapshot`，别用旧编号。

## 验证

装好后让 agent 依次跑：

```text
computer_use_doctor
browser_open { "url": "https://example.com" }
```

正常情况下 doctor 会打印 `status: OK. The private browser is up and answers CDP.`，
`browser_open` 会把页面元素和截图一起返回。

## 实测记录（本机 Windows 11 + Edge 155）

```
smoke（本地页面，连跑 3 次）：3/3 全部通过
  cdp session      2.5–2.9s（冷启动）
  navigate         complete
  snapshot         3 elements
  button onclick   fired（事件日志：mousedown → mouseup → click）
  unicode insert   "小伙" 正确进入 input
  submit           回读 "hi 小伙"
  screenshot       12544 bytes

live（真实网站）
  https://example.com    navigate 1477ms，元素 1 个
                         点击 "Learn more" → 跳转 iana.org ✓
```

## 已知边界

- **只覆盖浏览器里的东西。** 本地软件的窗口和控件不在这一版范围内，那是桌面平面的活（见 Roadmap）。
- **私有 profile 是全新的。** 它没有你日常浏览器的 cookie 和登录态，需要登录的站点得在它里面登一次；登录态会保存在 `<DSH_HOME>/dsh-computer-use-bg/profile`，下次复用。
- **CDP 端口是本机回环。** 默认只监听 `127.0.0.1`。要远程用，别直接暴露，走 SSH 隧道。
- **`--headless` 下部分站点会识别出无头浏览器。** 默认有头（窗口独立，不干扰你）。
- **`browser_eval` 能执行任意 JS。** 只在你信任的页面上用。

## Roadmap

- [ ] **桌面平面**：UIA 控件树（文本，不用截图）+ 隔离桌面（`CreateDesktop`）里跑真实输入，让本地软件也能操作而不抢前台 —— 这是 `@copylee` / `windows-mcp` 那套做不到的
- [ ] 多标签页管理（`Target.createTarget` + sessionId 复用）
- [ ] 元素截图裁剪（只发目标区域的图，省 token）
- [ ] `browser_wait`：等元素出现 / 等导航完成，替代固定 sleep

## 开发

```bash
node tests/smoke.mjs          # 本地页面端到端：点击、输入、键盘、截图
node tests/live.mjs           # 真实站点：导航 + 点击跳转
node tests/live.mjs https://github.com
```

代码结构：

```
lib/cdp.js     零依赖 CDP 客户端 + 私有 Chromium 生命周期
lib/page.js    页面操作（快照 / 点击 / 输入 / 键盘 / 截图 / 文本）
lib/index.js   插件入口：apply(ctx, config) 与工具定义
tests/         端到端验证
```

## 踩过的坑（写给后来改这代码的人）

1. **`/json/list` 里的 `about:blank` 是个陷阱。** 它能建立 WebSocket 连接，但 `Runtime.evaluate` 永远不返回。必须用 `PUT /json/new?about:blank` 自己建页面，并且在连上后做一次 `1+1` 健康检查。
2. **输入事件要留间隔。** `mouseMoved → mousePressed → mouseReleased` 三连发太快，渲染器会丢掉 release，页面收不到 `click`。每步之间留 60ms。
3. **导航刚完成时点击不可靠。** `Page.navigate` 返回不代表渲染器已经能接收合成输入，点击前要 settle。
4. **后台化的 target 会静默丢弃输入。** 创建 target 后调一次 `Page.bringToFront`。

## License

MIT
