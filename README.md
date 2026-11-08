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
| **是否弹窗口** | 会（占你的桌面） | **不弹**：默认无窗口运行，只在截图里看到画面 |
| 你在干嘛 | 必须停下来 | 照常用电脑 |
| 换分辨率/缩放 | 点偏了要重算 | 无关（不用像素猜） |
| 本地软件 GUI | 能 | **暂不支持**（见 Roadmap） |

默认 `headless: true`，浏览器进程在后台跑，屏幕上不会多出任何窗口；任务结束空闲 5 分钟后进程自动退出，不留残余。想看它到底在点什么，把 `headless` 改成 `false` 就会弹出这个独立窗口（仍然不抢你正在用的浏览器）。

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
    port: 9411            # CDP 端口；被占用会自动往后找空端口
    headless: true        # 默认 true = 完全无窗口；改成 false 才会弹出可见窗口
    idleMs: 300000        # 空闲多久自动关掉浏览器（0 = 不自动关）
    width: 1440           # 视口宽（截图与坐标 1:1）
    height: 900
    browserPath: ''       # 留空自动探测 Edge/Chrome
    profileDir: ''        # 留空用 <DSH_HOME>/dsh-computer-use-bg/profile
    downloadDir: ''       # 留空用 <DSH_HOME>/dsh-computer-use-bg/downloads
    timeoutMs: 25000      # 冷启动等待上限
    dialogBehavior: accept  # accept | dismiss —— alert/confirm/prompt 怎么自动应答
    dialogPromptText: ''    # dialogBehavior=accept 时，prompt() 返回的默认文字
    followNewTabs: true     # 点击开出来的新标签页（target=_blank / OAuth 弹窗）自动跟过去
    attachUrl: ''         # 设了就默认接管这个 DevTools 端点，而不是自己起浏览器（如 http://127.0.0.1:9333）
    desktop: true         # 桌面平面（原生窗口）总开关；需要 Python 3
    pythonPath: ''        # 留空自动找：DSH 自带的 python → python → python3 → py -3
    desktopIsolated: true # desktop_launch 默认把程序放到隔离桌面（看不见、抢不到焦点）
    shotDir: ''           # 留空用 <DSH_HOME>/dsh-computer-use-bg/shots
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
| `browser_wait` | 等条件成立：元素出现 / 文字出现 / 元素消失 / 加载完成。比固定 sleep 稳，超时会告诉你页面实际长什么样 |
| `browser_nav` | 前进 / 后退 / 刷新。到边界会明确报错，不会假装成功 |
| `browser_tabs` | 标签页：列出 / 新建 / 切换 / 关闭。点击开出来的新标签页会自动跟过去 |
| `browser_upload` | 给 `<input type="file">` 塞本地文件，不弹系统选择框（输入框是隐藏的也能塞） |
| `browser_drop_files` | 把**磁盘上的文件**拖进页面的 drop zone（`DataTransfer.files` 是真的文件） |
| `browser_download` | 看这次会话下载了什么、文件落在哪个绝对路径；`wait: true` 等到传输结束 |
| `browser_hover` | 悬停后告诉模型**新出现了什么**（下拉菜单、tooltip），并给这些新元素的 `ref`，接着就能点 |
| `browser_drag` | 拖拽：滑块、可排序列表、看板、拖放上传。结果会说明页面用的是 pointer 事件还是原生 HTML5 拖拽 |
| `browser_screenshot` | 只截一个元素或一块区域。比整屏省一个量级的图片 token，看小字还可以 `scale: 2` |
| `browser_attach` | 接管**已经在运行**的应用（DSH 自己、Chrome、VS Code…）：用它的 DevTools 端口，不需要 token；`accessibility: true` 还能让它发布原生无障碍树 |
| `browser_close` | 关掉私有浏览器（profile 保留，下次复用）；接管模式下调它只是松手，不会关掉那个应用 |
| `desktop_windows` | 列出**原生窗口**：自己的桌面 + 本插件开的隔离桌面，带进程、pid、尺寸 |
| `desktop_tree` | 读一个原生窗口的**语义控件树**（UI Automation）：角色、名字、`u1` 这样的 ref；读不到再退回 Win32 子窗口 |
| `desktop_act` | 点 / 输入 / 按键 / 滚动 / **读文本框内容** / 关闭。`u…` ref 走控件自己的模式（Invoke / Value），不移动鼠标、不抢焦点 |
| `desktop_shot` | 截一个原生窗口（客户区），窗口被遮住也能画出来；`grid: true` 会在图上叠一把像素标尺 |
| `desktop_find` | 在**没有控件树**的窗口里找东西并给出**可点的坐标**：按文字（系统自带 OCR）或按颜色（图标按钮就是一块纯色） |
| `desktop_launch` | 启动一个本机程序，默认放进**隔离桌面**：正常运行，但窗口不出现在你屏幕上 |

`ref` 编号每次快照都会重排 —— 页面变了就重新 `browser_snapshot`，别用旧编号。

**iframe**默认就会进去看，不管同源还是跨域，都不需要额外参数：快照会遍历所有能读的子框架，里面的元素照常编号，行尾标 `(f0)` / `(f0.1)` / `(fx0)` 表示它属于哪个框架（`x` 开头的是**独立进程**里的框架）。坐标**已经换算到顶层视口**，所以 `browser_click` / `browser_type` / `browser_hover` 直接就能用；`browser_text` 会把子框架的文字也拼进来并标注 `[frame 0]`；`browser_wait` 的选择器同样能命中框架内部（跨域框架由 Node 侧并行轮询，命中就立刻返回，不会白等预算）。

跨域框架能读，是因为 Chrome 给了两条不同的路：**不同源但同站**（另一个端口、另一个子域）的框架还在同一个渲染进程里，用 `Page.createIsolatedWorld` 建一个隔离世界就能查；**不同站**（真正的第三方嵌入）会被站点隔离拆到独立进程，它**根本不在页面级 frame tree 里**，只能靠 `Target.attachedToTarget` 拿到会话，命令都要带 `sessionId`。两种都实测覆盖了——测试里同时摆了这三个场景。

只有确实读不到的（比如浏览器给了框架 id 却不肯给脚本上下文）才会写 `N cross-origin frame(s) still cannot be read`，并给出原因。

**右键**用 `browser_click { "button": "right" }`。它触发的是页面的 `contextmenu`（web app 自己的菜单会正常弹出）；浏览器原生的那个菜单在无窗口模式下不渲染，也点不到——真要操作它请改 `headless: false`。

**拖拽**有两种互不相干的机制，工具会自己分辨并在结果里说明：

- `pointermove` 型（dnd-kit / SortableJS / 所有滑块）：中间要发足够多的 `mouseMoved`，一次从 A 跳到 B 会被当成没动。默认 14 步，库不认就调大 `steps`。
- 原生 HTML5（`draggable="true"`）：`dragstart` / `dragover` / `drop`。**目标必须自己处理 `dragover` 并 `preventDefault()`**，否则永远收不到 `drop`——结果里会明确写「起了个 drag 但没有 drop」，而不是假装成功。

**从系统拖文件进页面**用 `browser_drop_files`：拖的是真实磁盘路径，`DataTransfer.files` 里是文件本体（名字、大小、内容都对），所以「拖张图进来上传」这类控件也能用。目标同样得接得住——`dragover` 里不 `preventDefault()` 的 div 会被浏览器直接拒收，结果会写「没有 drop 事件到页面」。有真正的 `<input type="file">` 时优先用 `browser_upload`，那条路更稳。

**多标签页**：`target="_blank"`、OAuth 弹窗、`window.open` 都会开新标签页，而页面级 CDP 会话不会自己跟过去——点击看起来就"什么都没发生"。插件每次调用后对比一次标签页集合，发现新的就**自动跟过去**，并在结果末尾说明：

```
(new tab opened and is now the active tab: "popup page" — file:///.../popup.html, id 8F3C....
 The element list above belongs to the page you just left — those refs are stale now, so call browser_snapshot to read this tab.)
```

不想要这个行为就设 `followNewTabs: false`，再自己 `browser_tabs { "action": "select" }`。浏览器自己的界面（`edge://downloads-hub`、`chrome://settings`）**不算标签页**：不列出来、也不跟随——Edge 每次下载都会开一个，跟过去等于把会话从网站上拽走。

**只截一块**用 `browser_screenshot`，四种给法：`ref` / `text` / `selector` / `x,y,width,height`。它会先把目标滚到视口中央再截，所以**坐标会变**（结果里会写滚到哪了）；区域超出视口会被裁到可见部分并明确说明，而不是塞给你一张灰图。看小字加 `scale: 2`。

`alert` / `confirm` / `prompt` 会**自动应答**（默认 accept），否则渲染器会卡死、后面每条命令都超时。被应答的对话框会附在下一次工具结果的末尾，例如 `(dialog handled automatically: confirm("sure?") — accepted)` —— 不会悄悄吞掉。要改成 dismiss，见下面的 `dialogBehavior`。

**下载不会丢。** 无窗口浏览器默认把下载直接丢弃——点「导出 CSV」成功了却什么都没有，看起来像按钮坏了。插件启动时就把下载控制打开（`Browser.setDownloadBehavior`），文件落在 `<DSH_HOME>/dsh-computer-use-bg/downloads`（`downloadDir` 可改）。因为**下载不改变页面**，结果末尾会主动附一句：

```
(download: "report.csv" finished (12.3 KB) — F:\Deepseek\data\dsh-home\dsh-computer-use-bg\downloads\report.csv)
```

也就是点完就知道，不用额外调用。要看全量、或等大文件下完，用 `browser_download`（`wait: true` 会阻塞到传输结束）。同名下载**不会互相覆盖**：第二份叫 `report (1).csv`。

默认不写系统「下载」文件夹是有意的：那是用户的目录，插件不经允许不该往里放东西；想把 `downloadDir` 指到那里随时可以。

## 自绘窗口（Electron）：为什么桌面平面看不见控件

DSH、VS Code、Slack、微信桌面版这类应用的整个界面是 Chromium 自己画出来的。在 Win32 眼里
它只有**一个顶层窗口**，没有子控件——所以 `desktop_tree` 会如实回答"这个窗口自己画，没有子控件"。
**这不是故障，是 Electron 的形态**，任何靠枚举子窗口的办法都看不到里面的按钮。

更麻烦的是：对 Chromium 窗口，连"按坐标 posted 一个点击"也没用——它只认真实输入。

正确的办法是 `browser_attach`：这类应用只要带 `--remote-debugging-port` 启动，DevTools 就能看到
**每一个 DOM 元素**。DSH 本来就是这么启动的（`StartDSH.bat` 第 36 行，端口 9333，**不需要 token**）：

```text
browser_attach                 # 默认就连 DSH 自己的 9333
browser_snapshot               # 现在拿到的是应用界面的元素清单
browser_click { "ref": 12 }    # 按元素点，不猜坐标
browser_close                  # 只是松手，DSH 不会被关掉
```

接管模式对你那个应用的承诺，条条有测试盯着：

- **不新建标签页**（不然会凭空多一个窗口）；
- **不改窗口尺寸**（`Emulation.setDeviceMetricsOverride` 在接管时被跳过，否则你的布局会被改掉）；
- **不动下载**（否则你的下载会被导进插件的目录）；
- **不关进程**：`shutdown()` 只关自己的 socket；`browser_close` 等于放手。

代价是它驱动的是**你正在看的那个窗口**——同一个界面，操作会互相看见。要互不干扰，还是走私有浏览器。

## 桌面平面（原生窗口）

浏览器那套只覆盖有 DOM 的东西。微信、Word、安装包、记事本这些**没有 DOM**，但它们有窗口、有子控件、有消息队列——三样都能在不碰前台窗口的前提下操作。桌面平面就是干这个的，走的是 `helpers/desktop-agent.py`（Win32 + ctypes，除标准库外零依赖），插件通过**一行一条 JSON** 的管道驱动它。

```text
desktop_windows                       → 找窗口，拿到 w004e0592
desktop_tree { window }               → 读控件，拿到 c000c0682
desktop_act  { action:"type", target, text }
desktop_act  { action:"read", target } → 读回来，确认真的写进去了
```

**隔离桌面是重点。** `desktop_launch` 默认先 `CreateDesktopW` 建一个隐藏桌面，再把程序和一个小 worker 一起放上去。worker 在那边负责枚举、画图、发消息，主进程通过回环 socket 中转。因为 Windows 的 `EnumWindows` / `PrintWindow` 只看**调用线程所在的桌面**，所以必须有进程住在那个桌面上。效果：

- 程序的窗口**不出现在你的屏幕上**，不会盖住你的东西，也不会抢焦点；
- 你照样能读它的控件、往里打字、截图、点按钮；
- 关掉插件（或它自己退出）时这些桌面和进程一起消失。

**点击**是往目标控件 `PostMessage(WM_LBUTTONDOWN/UP)`，光标不动、焦点不变。标准控件（按钮、编辑框、列表）接得住；少数只认真实输入的现代应用会忽略它——结果里会提醒你先 `desktop_shot` 看一眼再换目标。`desktop_act` 的 `x`/`y` 是**客户区像素**，和 `desktop_shot` 返回的图一一对应。

**输入文字**：`Edit` / `RichEdit` 类控件走 `WM_SETTEXT`（一次写完整串，中文没问题），其它控件逐字符 `WM_CHAR`。写完务必用 `action:"read"` 读回来——打字没进去和打字成功，从外面看是一样的。

**截图**用 `PrintWindow` 让程序自己画到我们的位图里，所以窗口被遮住也能截；最小化的窗口没东西可画，会直接说而不是给一张黑图。

**看得到什么，取决于走哪条路。** 先试 **UI Automation**（Windows 的无障碍接口，读屏软件用的那套）：它给出角色、名字和可操作模式的**语义树**。同一个记事本窗口——

```text
Win32 子窗口枚举   2 个   （就两个 HWND）
UI Automation     21 个   （文本编辑器 / 状态栏 / 垂直滚动条 / 上一行 / 下一行 /
                            菜单栏 文件(F)·编辑(E)·格式(O)·查看(V)·帮助(H) / 最小化 最大化 关闭 …）
```

读不到才退回 Win32 子窗口枚举（想强制老路：`desktop_tree { "engine": "win32" }`）。

`u1`、`u2` 这类 ref 是**语义元素**，动它们用的是控件自己暴露的模式：

- **点击** → `Invoke` / `Toggle` / `Select` / `Expand`。不移动指针、不抢焦点，窗口被别的窗口盖住也照样生效；只有在控件一个模式都不给、但自己有窗口时才退回 posted 点击。
- **输入** → `Value.SetValue`；没有值模式的老控件（记事本的编辑框就是）改用它的窗口消息写。
- **读** → `Value` → `Text` → 窗口消息，三级降级。三级都不行时只说"只有名字可用"，**不会把名字当成内容返回**。

### 没有任何控件树的时候（游戏、canvas、远程桌面）

这类窗口里连一个语义节点都没有，唯一能做的就是 **看 → 估坐标 → 点 → 再看**。这条路能不能用，取决于三件工程上的事，都实跑验证过（`tests/canvas.mjs`，一个真 Chromium 窗口里跑的 canvas 场景：三个画出来的按钮、一块静止面板、一块每帧重新随机噪点的区域）。

**1. 坐标不能有歧义。** `desktop_shot` 截的是**客户区**，`desktop_act` 的 `x`/`y` 就是这张图上的像素——同一个坐标系，1:1，不存在缩放换算（这是视觉方案最常见的静默失败：Retina 截图是物理像素、点击是逻辑点，差一个固定倍率）。要估坐标就加 `grid: true`，图上会叠一把标尺：

```text
desktop_shot { "window": "w004e0592", "grid": true }
→ 图上每 100px 一条线，每 200px 一个刻度数字
desktop_act  { "window": "w004e0592", "x": 412, "y": 96 }
```

顺带一个实测数字：同一个 Chromium 窗口，**页面坐标和客户区坐标差 31px**（页面之上那条带）。所以只有从截图读出来的坐标才作数——按应用内部的坐标去点，会整体错一行。

**2. 截图必须真的截到东西。** 合成窗口（Chromium、游戏、任何 DWM 画的东西）的 `PrintWindow` 有个恶劣行为：**第一次返回的是这次调用之前那一帧**，也就是一片空白，而且 `PrintWindow` 报成功。`desktop_shot` 因此在内部抓两次取更丰富的那张，并返回 `colours`（不同颜色数）：

```text
实测：第一次 10 种颜色（只有标题栏），第二次 64 种（真内容）
```

只截一次的实现会得到一张"看起来就是个空应用"的图，然后下一步对着空气点。现在颜色数过低时结果里会直接说"这张图几乎是单色的，多半是没画出来，重截一次"。

**3. 点完要能验证——但验证必须拿噪声当尺子。** 这是这一版真正改掉的东西。原来的做法是比较整窗，在有动画的界面上**完全失效**：实测同一个 canvas，点中按钮变化 0.7%，点空白变化 2.7%——数字反了，因为点空白那次动画正好滚过去了。

现在的做法：动作前连拍三帧当基线，然后分别测量

- `noise`：这块区域**自己**在两次之间变了多少（场景本身的动静）
- `signal`：动作之后变了多少

判据只有"信号 vs 噪声"，三种结论各自对应一种现实：

```text
点中静止的按钮     signal 0.7%  noise 0.0%   → the action landed
点静止的空面板     signal 0.0%  noise 0.0%   → nothing changed（点空了）
点一直在变的区域   signal 37.8% noise 38.8%  → 无法判断，明确说"像素不能作证"
```

第三条是这套方案里最重要的一条：**信号淹没在噪声里的时候，诚实的答案是"不知道"**，而不是给个自信的猜测。这时候结果会明确让你换一条路确认（`desktop_act "read"`、`desktop_shot`、或应用自己的状态）。

另外两个信号仍然有用：有没有**新窗口**冒出来（点按钮弹对话框时，父窗口像素可以一点不变）、窗口是不是**已经关掉**了。

**4. 找，而不是估。** 上面三条都在让"估"更可靠；`desktop_find` 干脆不估了。画出来的界面只有两种线索，它两种都收：

```text
desktop_find { "window": "...", "text": "START" }
→ "START" at (74, 91) 78x16 — centre (105, 99)
desktop_find { "window": "...", "color": "#2f6f4f" }
→ #2f6f4f at (60, 71) 140x54 — centre (130, 98)
```

文字走 **Windows 自带的 OCR**（`Windows.Media.Ocr`，装了语言包就能用，不用额外装任何东西），返回的是**文字加上它的外接矩形**；颜色走像素扫描，图标按钮本来就是一块纯色。两者都在客户区坐标系里，`desktop_act` 拿去就能点。

几个刻意设计的地方：

- **近似匹配**。OCR 不是查表：canvas 上画出来的 `START 0`，它有时读成 `STARTO`（吃掉空格）。要求精确命中就会对明明在屏幕上的按钮回答"找不到"，那是唯一没法用的答案。所以先子串、再按相似度（≥0.75）兜。
- **找不到时报告读到了什么**。空列表没法排查，"这张图上是这些字"能。
- **颜色盖住整窗时会拦下来**。默认容差会把背景也算进去，这时返回的"中心"是随便一个位置——工具会说"这是背景不是控件"，让你缩小范围或降容差。
- **OCR 不可用不影响颜色搜索**，反之亦然；两者都用不了时说清楚原因（没装语言包 / 脚本执行被限制）。

> **平台边界（实测，非实现取舍）**：隔离桌面（`desktop_launch` 默认）上的合成窗口**根本不会被绘制**——它在 DWM 眼里不存在，`PrintWindow` 拿到的永远是空白，五种 flag 组合、强制重绘、移动窗口全试过，都一样。所以要在看不见的桌面上操作 Chromium / 游戏这类自绘应用，只能 `isolated: false`，或者干脆用 `browser_attach`（那才是这类应用的正当入口）。记事本、对话框这类 GDI 绘制的原生控件在隔离桌面上完全没有这个问题。

### Electron / Chromium：空壳是可以打开的

Chromium 的 Web 无障碍树是**惰性构建**的——只有检测到辅助技术来查询才建。所以一个正在跑的 Electron 应用，在 UIA 眼里往往只有一个空 pane，这就是"整窗自绘、读不到"的真正原因，而不是它不支持无障碍。

`browser_attach { accessibility: true }` 会通过 CDP 把 `Accessibility.enable` 打开，让那个应用**当场把原生树建起来**。实测（同一个 Chromium 窗口，用本插件的 UIA 读）：

```text
开关前   26 个控件 —— 标题栏 / 工具栏 / 地址栏 / 标签页，页面内容一个都没有
开关后   29 个，多出来的正是页面：
         document / a11y probe
         button   / Pay now
         text field / Card number
```

意义在于：打开之后，**任何**读 UIA 的工具（本插件的 `desktop_tree`、屏读软件、别的自动化框架）都能看见它，而不只是持有 CDP 会话的那一方。开关会一直有效到那个应用重启。

**为什么是 Python**：UIA 那条路（.NET `UIAutomationClient`）控件树更丰富，但开发环境里 `Add-Type` 一类调用被沙箱拦死，**一条命令都验证不了**。与其交付一堆没跑过的自动化代码，不如用一条每条断言都实跑过的路。

**不用你装 Python。** 探测顺序是：`pythonPath` 配置 → `DSH_BG_CU_PYTHON` 环境变量 → **DSH 自带的运行时**（`<DSH_HOME>/dsh-runtimes/*/dependencies/python/python.exe`，实测 3.12）→ `python` / `python3` / `py -3`。每个候选都要**真的跑一次** `import ctypes` 才算数——Windows 上 `python` 常常是应用商店的占位程序，它存在、它能运行、它打印的是广告。都不行时才报"不可用"，浏览器侧照常工作（`desktop: false` 可以彻底关掉）。

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

窗口行为（默认配置，走插件真实入口 apply/execute）
  plugin 起的 8 个 Edge 进程   MainWindowHandle 全部 = 0，窗口标题全为空
  用户自己开的 10 个 Edge 进程  完好未受影响
  结论                          屏幕上零新增窗口

Chromium 的无障碍树（同一个窗口，本插件的 UIA 读）
  Accessibility 关闭     26 个控件：标题栏 / 工具栏 / 地址栏 / 标签页，页面内容 0
  Accessibility.enable   29 个：多出 document + button "Pay now" + text field "Card number"

桌面平面的动作验证（隔离桌面里的记事本 / winver）
  type                    changed: 重绘 0.05%，区域 (3,6) 91x13（正是第一行文字）
  click 对话框「确定」      closed: true（窗口已消失）

空闲回收（idleMs = 2500ms）
  用完当下                    子进程存活
  4 秒后                      进程已退出，host.child = null
```

## 已知边界

- **浏览器和原生窗口是两套东西。** `browser_*` 只管私有浏览器里的页面；本地软件走 `desktop_*`（桌面平面）。两边互不影响：关掉浏览器不动桌面 helper，反之亦然。
- **私有 profile 是全新的。** 它没有你日常浏览器的 cookie 和登录态，需要登录的站点得在它里面登一次；登录态会保存在 `<DSH_HOME>/dsh-computer-use-bg/profile`，下次复用。
- **CDP 端口是本机回环。** 默认只监听 `127.0.0.1`。要远程用，别直接暴露，走 SSH 隧道。
- **`--headless` 下部分站点会识别出无头浏览器。** 默认就是无窗口，遇到硬性反爬的站点可临时把 `headless` 设成 `false` 再试一次。
- **无窗口就意味着你看不到过程。** 想确认它点了哪儿，用 `browser_snapshot`（默认带截图，只是它落在对话里而不是屏幕上）；想全程盯着看，把 `headless` 改成 `false`。
- **空闲会自动关闭。** 默认 5 分钟无操作后杀掉浏览器进程，下次调用重新拉起（冷启动约 7 秒）。要常驻就把 `idleMs` 设成 `0`。
- **`browser_eval` 能执行任意 JS。** 只在你信任的页面上用。
- **`browser_hover` 的「新出现了什么」靠对比两次元素快照。** 画在 canvas 里、或者只改了自己尺寸而没有新 DOM 元素的弹层（少数老式编辑器）看不到，这时候改用坐标 + 截图判断。
- **拖拽只覆盖页面内部的元素。** 从资源管理器拖文件进网页要单独用 `browser_drop_files`（它靠 CDP 的 drag 通道带真实路径，不是鼠标手势）；纯鼠标拖拽做不了这件事。
- **跨域 iframe 能读，但读的是它自己的文档。** 页面 JS 里的变量（`window.xxx`）在隔离世界里看不到，能读能点的是 DOM、文字和控件。少数把内容画在 canvas 上的第三方嵌入（地图、编辑器）依然只能截图看。
- **iframe 内的元素坐标是"顶层视口坐标"。** 如果 iframe 自己有内部滚动条且内容滚到底了，坐标仍然正确；但如果页面在快照之后滚动了外层容器，`ref` 就要重新取。
- **下载控制是浏览器级的。** `Browser.setDownloadBehavior` 没有指定 context，所以这个私有浏览器里任何页面发起的下载都会落盘并被记录，包括开在新标签页里的链接——那个标签页现在也能直接读（`browser_tabs`）。
- **大到超出 `browser_download` 默认 30 秒预算的文件**不会等完 —— 它会如实说「still downloading」，稍后再查即可，文件继续在后台传。
- **浏览器自己的界面页不算标签页。** `edge://`、`chrome://` 这类地址不列在 `browser_tabs` 里、也不会被自动跟随：那是浏览器 UI，不是网页，驱动它没有意义。它们照样占着一个真实标签页，所以「标签页数量」可能比你看到的多。
- **桌面平面需要 Python 3（只用标准库）。** 找不到时它会明确报"不可用"，浏览器侧照常工作。`desktop: false` 可以彻底关掉。
- **UI Automation 能读的地方有语义树，读不到退回 Win32。** WPF / WinForms / 老 Win32 都在前者；纯 canvas 自绘两边都空，只能走上面的标尺 + 验证闭环。**Electron 的空壳是可以打开的**：`browser_attach { accessibility: true }`。
- **UIA 的 ref 只对最近一次 `desktop_tree` 有效。** UI 变了就重新读：旧 `u…` 会明确报 `no element "u7" in the last snapshot`，不会静默点错地方。
- **少数控件两种文本模式都没有**（既无 `Value` 也无 `Text`，窗口也不吐文字）。这时 `read` 会明说"只有名字"，不会假装读到了内容。
- **设备像素比不是 1 的屏幕上，视觉坐标会有偏差。** 插件的截图和坐标都在同一坐标系里（客户区 CSS 像素），所以内部一致；但如果 Windows 显示缩放是 150%，你用肉眼看屏幕量出来的数字不能直接当 `x`/`y`——以 `desktop_shot` 返回的图为准。
- **验证是启发式的**：闪烁的光标、动画、时钟会让"变了"误报为真。它给的是"变了/没变 + 变了哪里"，判断仍归调用方。
- **posted 消息不是真实输入。** 少数应用只认 `SendInput`（真实输入），会忽略 `PostMessage`。这条路**故意不默认走**：真实输入必然要抢前台，那就不是"后台"了。
- **最小化的窗口截不到内容**（没有东西被绘制），会直接报错而不是给黑图。`desktop_launch` 启动的程序默认不最小化。
- **隔离桌面里的程序你用肉眼看不到。** 这是它的用途，但也意味着出了问题只能靠 `desktop_windows` / `desktop_tree` / `desktop_shot` 观察。想看着它跑，`isolated: false`。
- **桌面 helper 也会空闲回收**（默认 5 分钟没调用就退出，连带它拥有的隔离桌面和程序一起消失）。

## Roadmap

- [x] **对话框**（`alert` / `confirm` / `prompt`）：打开即自动应答并写进结果，页面不会再被卡死
- [x] **`browser_wait`**：等元素 / 文字 / 消失 / 加载完成，替代固定 sleep
- [x] **`browser_nav`**：reload / back / forward，到边界明确报错
- [x] **`browser_upload`**：给隐藏的 `<input type="file">` 直接塞文件
- [x] **hover / 右键 / 拖拽**：`browser_hover` 报出新出现的元素；右键走 `browser_click {button:"right"}`；`browser_drag` 同时覆盖 pointer 型和原生 HTML5 拖拽
- [x] **同源 iframe**：快照 / 文字 / 等待 / 点击 / 上传都穿透子框架，坐标自动换算到顶层视口
- [x] **下载落盘**（`Browser.setDownloadBehavior`）：文件不再被丢弃，每次都报绝对路径，同名不覆盖
- [x] **多标签页**（`browser_tabs` + 每次调用后对比 target 集合）：`target=_blank` / OAuth 弹窗自动跟随，列表 / 新建 / 切换 / 关闭齐全
- [x] **从系统拖文件进页面**（`Input.dispatchDragEvent` + `files`）：`DataTransfer.files` 里是真实文件，名字和大小都对
- [x] **元素截图裁剪**（`Page.captureScreenshot` + `clip`）：按 ref / 选择器 / 区域出图，`scale` 可放大
- [x] **跨域 iframe**：不同源同站走 `Page.createIsolatedWorld`，跨站（独立进程）走 `Target.attachToTarget` + `sessionId`，快照 / 文字 / 等待 / 点击 / 输入 / 上传全部打通
- [x] **桌面平面（v1）**：`desktop_windows` / `desktop_tree` / `desktop_act` / `desktop_shot` / `desktop_launch`；隔离桌面（`CreateDesktopW` + 桌内 worker）里枚举、绘制、发消息，不抢前台
- [x] **桌面平面 v2（UI Automation）**：语义树 + 通过控件模式操作。走**裸 COM**（`IUIAutomation` 的 vtable），不依赖 .NET 也不依赖 `comtypes`——这样在这个环境里能逐条验证，而不是交付一段没跑过的代码
- [x] **无控件树时的闭环**：像素标尺（`grid`）+ 动作前后对比（噪声 vs 信号 / 新窗口 / 已关闭 / 什么都没变）
- [x] **按内容定位**（`desktop_find`）：文字用系统 OCR、图标用颜色，返回可直接点击的客户区坐标
- [x] **让 Chromium 应用发布原生无障碍树**（CDP `Accessibility.enable`）：Electron 的"空壳"从此可读，且对任何 UIA 工具生效
- [ ] 桌面平面的**真实输入**可选模式（`SendInput` + 主动抢前台），给那些忽略 posted 消息的应用
- [x] **本地 OCR**（`desktop_find`）：Windows 自带的 `Windows.Media.Ocr` 读出文字**和它的外接矩形**，"按钮在 (412,96)"从估计变成查表；用系统脚本宿主的 WinRT 投影调用，不引入任何依赖
- [x] **`browser_attach`**：接管已经在运行的 Chromium/Electron（DSH 自己的界面就是这样被驱动的），不新建标签页、不改尺寸、不关进程
- [ ] 跨域 iframe 里的 `browser_eval`（现在只在主文档执行）

## 开发

```bash
node tests/load.mjs           # 离线：按 DSH 的严格契约复刻注册校验（改动后先跑这个）
node tests/tools.mjs          # 工具接线：每个返回值都用自己的 output.schema 校验一遍
node tests/idle.mjs           # 空闲回收：进程确实会退出
node tests/smoke.mjs          # CDP 层端到端：点击/输入/键盘/截图/裁剪/等待/对话框/上传/导航/hover/拖拽/拖文件/跨域 iframe/下载/标签页（30 步）
node tests/desktop.mjs        # 桌面平面端到端：隔离桌面里启动记事本/对话框，读控件、输入、回读、截图、点击关窗
node tests/canvas.mjs         # 无控件树端到端：真 canvas 场景，截图定位 → 点中 / 点空 / 点在噪声区 → 按颜色和文字搜索
node tests/live.mjs           # 真实站点：导航 + 点击跳转
node tests/live.mjs https://github.com
```

`tests/schema.mjs` 是宿主那两个 schema 校验器的唯一副本，`load.mjs` 和 `tools.mjs` 共用它。
`tests/iframe-fixture.mjs` 起两个真实 HTTP 端口造同源 + 跨域框架——`file://` 页面之间全都是不透明源，用它测同源等于什么都没测。
`tests/download-fixture.mjs` 也一样：`Content-Disposition` 定名和"下载中的状态"只有真实 HTTP 响应能有，`file://` 触发不了下载。
`tests/png.mjs` 是给测试用的最小 PNG 解码器：裁剪截图对不对只能看**像素**（长度和尺寸都能骗人）。
`tests/desktop.mjs` 会在**隔离桌面**上真的开一个记事本和一个系统对话框：断言全部来自数据（语义树、控件文字、截图像素、`UIA Invoke` 之后窗口是否消失），不依赖"人看一眼"；跑完自己把进程和桌面清掉。
`tests/canvas.mjs` 在**可见桌面**上开一个画出来的 canvas（`tests/canvas-fixture.mjs`：三个按钮 + 一块静止面板 + 一块每帧重新随机的噪点区）——隔离桌面上的合成窗口根本不会被绘制，见上面那条平台边界。它验证的不是"能截到图"，而是**三种判定各自成立**：点中要有信号、点空要报没变化、点噪点区要老实说像素不能作证。每次点击是否命中都由页面自己的点击日志确认，不靠像素去猜。

代码结构：

```
lib/cdp.js      零依赖 CDP 客户端 + 私有 Chromium 生命周期（含浏览器级下载控制、标签页管理、OOPIF 会话）
lib/page.js     页面操作（快照 / 点击 / 输入 / 键盘 / 截图与裁剪 / 文本 / 等待 / 上传 / 拖文件 / 跨框架遍历）
lib/frames.js   页面 / 自己进程 / 独立进程三层框架的发现、隔离世界、坐标换算、跨帧等待与上传
lib/desktop.js  桌面 helper 的客户端（JSON 管道、python 探测、空闲回收）
lib/index.js    插件入口：apply(ctx, config) 与 24 个工具定义
helpers/        desktop-agent.py —— Win32 + ctypes；uia.py —— UI Automation 走裸 COM（无第三方依赖）
tests/          端到端验证
```

## 踩过的坑（写给后来改这代码的人）

1. **`/json/list` 里的 `about:blank` 是个陷阱。** 它能建立 WebSocket 连接，但 `Runtime.evaluate` 永远不返回。必须用 `PUT /json/new?about:blank` 自己建页面，并且在连上后做一次 `1+1` 健康检查。
2. **输入事件要留间隔。** `mouseMoved → mousePressed → mouseReleased` 三连发太快，渲染器会丢掉 release，页面收不到 `click`。每步之间留 60ms。
3. **导航刚完成时点击不可靠。** `Page.navigate` 返回不代表渲染器已经能接收合成输入，点击前要 settle。
4. **后台化的 target 会静默丢弃输入。** 创建 target 后调一次 `Page.bringToFront`。
5. **端口会被别的 Chromium 抢走，而它一样能应答。** DSH 自己就带 `--remote-debugging-port`（本机 `StartDSH.bat` 里是 9333）。旧版本只在启动前探一下端口：有东西应答就直接连上去，等于连到 **DSH 自己的 DevTools**，`browser_open` 会去导航应用窗口。现在改成：端口被占就往后找空端口，自己起浏览器，再用 `Browser.getBrowserCommandLine` 核对 `--user-data-dir` 是不是我们的 profile —— 认不上就杀掉重来，绝不碰别人的端点。端口默认值也因此从 9333 改成 **9411**。
6. **全新 profile 的 target 会假握手。** 新建的 profile 首次启动时，渲染进程还在初始化，target 能连上却一条命令都不回。连上后必须做健康检查，失败就换新 target 重试（最多 4 次，每次间隔 700ms）。
7. **别用浏览器级 socket + `Target.attachToTarget` 走会话。** 在这台 Edge 155 上，attach 之后渲染器直接 `Inspector.targetCrashed`，有头无头都一样。页面级 target 才稳。
8. **每个 tool 必须声明 `output: { schema, render }`，否则整个插件装不上。** 这是最贵的一条坑：DSH 的 `ToolService.register` 会直接抛错，插件在「插件」页显示红色「异常」，但**没有任何地方告诉你原因** —— 详情页只渲染 README。真实报错要这么挖：页面是 React 渲染的，沿插件行的 `__reactFiber$` 往上层找 `memoizedProps.pkg`，里面的 `rows[0].diagnostic` 才是原文：
   ```
   tool "computer_use_doctor" must declare output { schema, render, presentationMeta? }
   ```
   判定逻辑在 `@deepseek-ai/dsh-client-ui-plugin-manager/lib/client.js`：
   ```js
   if (pkg.error !== undefined || pkg.enabled && pkg.rows.some(r => r.phase === "failed")) return "problem";
   ```
   `render(args, value)` 返回 content block 数组，截图要给 `{ type: 'image', attachment: ref }`；`output.schema` 是 `additionalProperties: false`，所以 attachment ref 必须白名单裁剪，多一个字段都会校验失败。`tests/load.mjs` 现在原样复刻了这套校验，本地就能拦住。
9. **`output.schema` 是原始 JSON Schema，不是输入用的那套 DSL。** 上面第 8 条修完后插件还是「异常」，第二层诊断是：
   ```
   unsupported JSON schema: schema.properties.text.required is not supported on type "string";
   schema.properties.image.properties.attachmentId.required is not supported on type "string"  (共 8 条)
   ```
   原因：`parameters`（输入）走 DSH 自己的 DSL，`{ type: 'string', required: true }` 里的 `required: true` 表示"这个字段必填"，由 `valueSchemaSpecToJsonSchema()` 转成标准 JSON Schema；而 `output.schema` **已经是**标准 JSON Schema，`required` 必须是 object 节点上的**数组**。照抄 `@copylee/dsh-computer-use` 的字面结构就会踩这一脚。
   宿主的规则（`@deepseek-ai/dsh-tools/lib/shared-*.js` 里的 `assertSupportedJsonSchema`）：
   - 只认 `type / oneOf / properties / required / additionalProperties / items / enum / const`，注解只认 `description / title / default / examples`；
   - `properties|required|additionalProperties` 只能出现在 `type: "object"` 上，`items` 只能出现在 array 上；
   - `required` 是字符串数组，且每个名字必须在 `properties` 里存在；
   - `additionalProperties` 必须是显式 boolean；`type` 必须是单个字符串，不能是数组；`type` 和 `oneOf` 不能并存。
10. **`output.schema` 同时是返回值校验器。** 不是只做语法检查：`pipeline.js` 里每次调用成功都会跑 `validateJsonSchemaValue(tool.output.schema, value)`，不过就抛 `ToolOutputError`。所以 schema 写得比真实返回值严（比如把 attachment 的可选字段全标成必填）会在**调用时**炸。本插件的写法是：顶层 `required: ['text']` + `additionalProperties: false`（形状可控），图片引用 `required: ['attachmentId']` + `additionalProperties: true`（存储层将来加展示字段也不会炸）。
11. **`DOM.requestNode` 之前必须先 `DOM.getDocument`。** 否则它返回 `{ nodeId: 0 }` —— 不报错，看起来成功了，下一步才莫名其妙失败。要拿 iframe 里的元素，只能靠这个组合（`DOM.querySelector` 只查主文档）：`Runtime.evaluate` 遍历子框架返回元素 → 拿 `objectId` → `DOM.requestNode` → `DOM.setFileInputFiles`。跨 frame 的 `objectId` 是可以用的，不用切执行上下文。
12. **iframe 里元素的 `getBoundingClientRect()` 是相对它自己那个 viewport 的。** 要换算到顶层才有意义：逐层累加 `rect.left + clientLeft`（`clientLeft` 就是 border 宽度，漏了会偏几像素，足够点到旁边那个控件上）。另外**别把 iframe 内部滚动算进去**——`getBoundingClientRect` 已经把内部滚动算完了，再加一次就错。
13. **`iframe.contentDocument` 跨域时返回 `null` 而不抛错**（旧浏览器会抛）。两种情况都要接住，否则一个广告位就能让整页快照变成空。
14. **跨站 iframe 根本不在 `Page.getFrameTree` 里。** 站点隔离把它拆到独立进程后，页面级的 frame tree 只列同进程的框架——枚举少一个、点击坐标还算得对，只有"读不到内容"这一个症状。信号是 `Target.attachedToTarget`（`type: "iframe"`，`targetId` 就是 frameId），命令必须带 `sessionId`。晚开 `setAutoAttach` 也能收到已经存在的目标，这一点实测过，不用另做发现。
15. **`DOM.getBoxModel` 的 `content` 四元组是"顶层视口坐标"，而且随滚动更新。** 子框架自己的 `getBoundingClientRect` 是它自己视口的，两者相加就是顶层坐标——不要再叠祖先链，也不要做滚动补偿（滚 120px 后实测跟着变）。这和 `Page.captureScreenshot` 的 `clip` 是**文档坐标**正好相反，两个都栽过一次。
16. **`CreateDesktopW` 在 user32，不在 kernel32。** 猜错的表现是 `AttributeError: function 'CreateDesktopW' not found`，浪费一轮。
17. **`CreateProcessW` 的 `lpDesktop` 留空才是对的。** 留空 = 继承父进程桌面：父进程在用户桌面就开在用户桌面，worker 在隔离桌面就开在隔离桌面。写成"隔离桌面的名字"反而会让程序开到一个看不见、也查不到的地方（worker 的 `Isolated.name` 是 `worker`，照抄就中招）。
18. **`EnumChildWindows` 返回所有后代，不是直接子窗口。** 拿它做 BFS 会把孙子节点重复列两遍、深度还错。用 `GetWindow(hwnd, GW_CHILD)` + `GW_HWNDNEXT` 逐层走。
19. **`WM_SETTEXT` 的字符串必须是活着的缓冲区。** `send(WM_SETTEXT, 0, cast(c_wchar_p(text), c_void_p).value)` 这句里，临时 `c_wchar_p` 在 `.value` 取完之后就没有引用了，GC 可以在调用前回收——控件于是把那段已释放的内存存下来，读回去是几个乱码（本例是 `"붰戆˲"`）。改成 `create_unicode_buffer` 存变量，`addressof` 传地址。
20. **python 子进程的 stdio 不 `unref()` 会拖住宿主退出。** 测试跑完全绿却不退出，卡在事件循环上。`child.unref()` 加上三个管道一起 unref，读还是照常读，只是不再计入 ref count。
21. **`SendMessageTimeoutW` 跨桌面会被静默拒绝。** 所以"看另一个桌面的窗口"不能靠一次 SendMessage 解决，必须有一个进程**住在那张桌面上**（worker 模式就是这么来的）。返回 0 时不要当成功，代码里要显式区分 `None`。
22. **`Page.captureScreenshot` 的 `clip` 是文档坐标，不是视口坐标。** 把 `getBoundingClientRect()` 的结果直接当 clip 传进去，会得到一张尺寸完全正确、内容纯白/纯灰的图 —— 不报错，看起来像"页面就是这么白"。必须先 `+ scrollX/scrollY`。`tests/smoke.mjs` 第 26 步专门解 PNG 验中心像素，就是为了钉住这一条。
23. **Edge 每次下载都会顺手开一个 `edge://downloads-hub/` 标签页。** 如果"有新标签页就跟过去"，点完导出整个会话就被拽到浏览器 UI 上，网站其实还在，但工具看着它、却读不到任何东西。所以 `listTabs()` 明确过滤 `edge:/chrome:/chrome-untrusted:` 这类 scheme —— 既不在列表里出现，也不参与跟随。
24. **浏览器级 socket 只能武装一次。** 冷启动会重新走 `#start()`，每次都 `Browser.setDownloadBehavior` 的话，旧 socket 不会自己关（泄漏），而且下载事件会重复计一份。现在只在 `browserConnection` 为空或已关闭时才重新武装。
25. **页面级 socket 收不到"新标签页"事件。** `Target.targetCreated` 只在浏览器级 socket 上，页面级只能看到自己被换了文档。所以跟随是靠**对比 target 集合**做的：每次工具调用后 `GET /json/list`，id 不在上次集合里的就是刚开出来的。
26. **关掉正在驱动的标签页会让会话悬空。** socket 会 `close`，之后每条命令都报 "CDP socket is closed"。`closeTab` 必须在自己关掉连接后挑一个还活着的标签页接上（一个都没有就新建），否则用户从此只能重启插件。
27. **`Browser.setDownloadBehavior` 在浏览器级 target 上，页面 socket 调不到。** 必须再开一条 `/json/version` 的 socket（本插件叫 `browserConnection`，和页面会话互不干扰），并且带上 `eventsEnabled: true`，否则 `Browser.downloadWillBegin` / `downloadProgress` **一个都不会来** —— 文件会落盘，但你无从知道。
28. **`behavior: "allow"` 会静默覆盖同名文件。** 这一点和日常浏览器的「下载」文件夹不一样：连点两次「导出 CSV」，磁盘上只剩一份，前一份数据被替换掉而且没有任何提示。改用 `allowAndName`（按 guid 存，绝不撞名），完成后再自己 `rename` 成 `report.csv` / `report (1).csv`。
29. **`downloadProgress` 的 `completed` 早于最终改名几毫秒。** 收到就去找文件会扑空（`existsSync` 为 false，看起来像"文件没下下来"）。所以路径解析是**惰性**的：拿不到就留空，下次读再试；`waitForDownloads` 在收尾时额外给 800ms 重试窗口。
30. **`allowAndName` 的文件名是 guid，`suggestedFilename` 只在事件里。** 协议从不告诉你最终绝对路径，所以「名字 → 路径」这一步只能自己做。反过来这也意味着：**文件名来自 HTTP 响应头**，写盘前必须自己清洗 `\ / : * ? " < > |`，不能当成可信输入。

31. **接管别人的浏览器，有四件事一件都不能做**：`PUT /json/new`（会凭空给人开一个窗口）、
    `Emulation.setDeviceMetricsOverride`（会把用户正在看的布局改小，坐标和截图从此对不上）、
    `Browser.setDownloadBehavior`（会把用户的下载导进插件目录）、`GET /json/close`
    （那是**关掉整个浏览器**，不是关连接）。最后一条最要命：它就在 `shutdown()` 里，
    而空闲回收也会走到 `shutdown()` —— 少了 `if (this.foreign) return;`，一次 5 分钟空闲
    就能把用户开着的 DSH 关掉。`tests/attach.mjs` 里专门有一步在 `shutdown()` 之后检查
    "那个浏览器还活着吗"。

## License

MIT

---

## 附：为什么 UI Automation 走裸 COM

UIA 的常规入口是 .NET（`System.Windows.Automation`）或 `comtypes`。两条路在这个环境里都不成立：
前者要 `Add-Type` / `Reflection.Assembly`（被沙箱拦死，一条命令都验证不了），后者是第三方依赖。

但 UIA 本身就是个 COM 对象：`CoCreateInstance(CLSID_CUIAutomation, IID_IUIAutomation)`，之后每个方法
就是 vtable 上固定位置的一个函数指针。所以 `helpers/uia.py` 直接按槽位调用：

| 调用 | 槽 | 用途 |
|---|---|---|
| `IUIAutomation::GetRootElement` | 5 | 桌面根 |
| `ElementFromHandle` | 6 | 窗口 → 元素 |
| `get_ControlViewWalker` | 14 | 遍历器（跳过纯装饰节点） |
| `CreateTrueCondition` | 21 | 无过滤条件 |
| `Element::get_CurrentName / ControlType / BoundingRectangle` | 23 / 21 / 43 | 读属性 |
| `Element::GetCurrentPattern` | 16 | 拿模式对象，再 `QueryInterface` 到 `IInvokePattern` 等 |

坑集中在三处：BSTR 要 `SysFreeString`、遍历器返回的每个元素要 `Release`、COM 必须在自己线程
`CoInitializeEx`（worker 模式下是另一个进程，各初始化一次）。

32. **动作验证要等一小会儿再截"之后"的图。** posted 的点击和界面变化不是同一瞬间：对话框在鼠标抬起后一两个帧才销毁，立刻截图会拍到"按钮还按着"的像素，于是报告"变了"而不是"已关闭"。加 150ms 就没这个问题。
33. **像素标尺的字号不能省。** 3x5 点阵字体按 scale=2 画出来，在 1440px 宽的图里缩略一看全糊成小方块——等于没画。scale=4 才真正能读。
34. **`desktop_act` 的分支要整段提成函数再包验证。** 原来每个 action 都直接 `return`，想在外面套一层"前后对比"就必须先把它变成 `_act_body(payload)`；顺手也让这段代码从 100 行的 if 链变成一个能单独读的函数。
35. **别在下拉菜单里找"自动打开无障碍"。** `Accessibility.enable` 是**有副作用**的（那个应用的渲染器会开始维护无障碍树，多花一点 CPU/内存），所以它是 `browser_attach` 的一个显式参数，不是默认行为。给别人应用悄悄开开关，不是插件该做的决定。
36. **`PrintWindow` 第一次拿到的是"这次调用之前"那一帧。** 合成窗口（Chromium、DWM 画的任何东西）实测：第一次 10 种颜色（只有标题栏），紧接着第二次 64 种（真内容），两次都报成功。只截一次的实现会交付一张"看起来就是这个应用空着"的图，然后下一步对着空气点。`capture()` 现在颜色数偏少就自动再抓一次、取更丰富的那张，并回报 `colours`。
37. **隔离桌面上，合成窗口根本不会被绘制。** 不是 flag 用错：`PW_CLIENTONLY`、`PW_RENDERFULLCONTENT`、默认值、`RedrawWindow`、`InvalidateRect`+`UpdateWindow`、挪动 1px、`ShowWindow`、`SetForegroundWindow`、等 2 秒——九种刺激全试过，拿到的都是同一片空白（10~12 色，全是标题栏）。GDI 绘制的记事本/对话框在隔离桌面上完全正常，所以这是 DWM 对"不在活动桌面上的合成层"的处理，不是实现取舍。这类应用该走 `browser_attach`，或者 `isolated: false`。
38. **整窗像素比较在有动画的界面上会给出反向结论。** 实测同一个 canvas：点中按钮变化 0.7%，点空白变化 2.7%——数字是反的，因为点空白那次动画正好滚过去了。判据必须是"信号 vs 这块区域自己的噪声"，而且噪声要在动作前实测（连拍三帧），不能假设为零。
39. **三帧基线也救不了"缓慢移动的大色块"。** 条纹宽 64px、每帧移 5px，三帧间隔 70ms 只移动 9px，条纹内部像素三帧同色 → 被判成静止 → 动作后再变就记成"点击生效"。降到阈值 8 反而更糟。这是像素法本身的上限，不是参数问题，所以判定改成"先量噪声再比"，噪声高就明说不能作证。
40. **测试里的动态元素必须圈在自己的地盘。** canvas 里的球原本横扫整块画布，偶尔滚过"静止面板"，于是"这里什么都没变"变成间歇性失败——症状和验证逻辑坏掉一模一样。把球限制在固定 band 之后连跑三次全绿。

41. **WinRT 的 `GetFileFromPathAsync` 不接受正斜杠。** 传 `F:/Temp/a.png` 得到的是一句 `AggregateException`（真正的异常被包在异步结果里），看上去像权限问题或 OCR 引擎坏了。必须 `os.path.normpath`。这一条花了两次往返才定位到。
42. **系统的脚本宿主里，WinRT 异步操作没有自动投影。** `[Windows.Media.Ocr.OcrEngine]` 这类类型能直接用，但返回的 `IAsyncOperation` 是个 `__ComObject`，没有 `.GetResults()`、`.Status` 也是空的。要么用 `AsTask` 扩展（在 `System.Runtime.WindowsRuntime` 里，得先加载程序集），要么改用 `ctypes` 直接打 vtable——后者要先从 `.winmd` 里挖出接口 IID。选前者：一次进程启动换零依赖。
43. **`.ps1` 默认跑不起来。** 执行策略会直接拒绝，报"在此系统上禁止运行脚本"。所有调用都要带 `-ExecutionPolicy Bypass`，并且 `-NoProfile -NonInteractive` + `CREATE_NO_WINDOW`，否则会在用户面前闪一个控制台窗口。
44. **OCR 会认错字，而且错得不规律。** canvas 上画出来的 `START 0`，同一台机器、同一个引擎，有时读成 `START`，有时读成 `STARTO`。要求精确命中就会对明明在屏幕上的按钮回答"找不到"——所以匹配是"先子串、再相似度 ≥0.75"。反过来，短于 4 个字符的查询不做模糊，否则什么都匹配得上。
45. **颜色搜索的容差会把背景一起吃进去。** 默认 24 时，面板色 `#1a2430` 把窗口底色 `#101318` 也算了进来，返回一个 904x645 的"块"，中心点指向任意位置。判据不是"有没有匹配"，而是**匹配面积占窗口的比例**——超过 60% 就直接告诉调用方"这是背景，不是控件"。
