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
    timeoutMs: 25000      # 冷启动等待上限
    dialogBehavior: accept  # accept | dismiss —— alert/confirm/prompt 怎么自动应答
    dialogPromptText: ''    # dialogBehavior=accept 时，prompt() 返回的默认文字
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
| `browser_upload` | 给 `<input type="file">` 塞本地文件，不弹系统选择框（输入框是隐藏的也能塞） |
| `browser_hover` | 悬停后告诉模型**新出现了什么**（下拉菜单、tooltip），并给这些新元素的 `ref`，接着就能点 |
| `browser_drag` | 拖拽：滑块、可排序列表、看板、拖放上传。结果会说明页面用的是 pointer 事件还是原生 HTML5 拖拽 |
| `browser_close` | 关掉私有浏览器（profile 保留，下次复用） |

`ref` 编号每次快照都会重排 —— 页面变了就重新 `browser_snapshot`，别用旧编号。

**右键**用 `browser_click { "button": "right" }`。它触发的是页面的 `contextmenu`（web app 自己的菜单会正常弹出）；浏览器原生的那个菜单在无窗口模式下不渲染，也点不到——真要操作它请改 `headless: false`。

**拖拽**有两种互不相干的机制，工具会自己分辨并在结果里说明：

- `pointermove` 型（dnd-kit / SortableJS / 所有滑块）：中间要发足够多的 `mouseMoved`，一次从 A 跳到 B 会被当成没动。默认 14 步，库不认就调大 `steps`。
- 原生 HTML5（`draggable="true"`）：`dragstart` / `dragover` / `drop`。**目标必须自己处理 `dragover` 并 `preventDefault()`**，否则永远收不到 `drop`——结果里会明确写「起了个 drag 但没有 drop」，而不是假装成功。

`alert` / `confirm` / `prompt` 会**自动应答**（默认 accept），否则渲染器会卡死、后面每条命令都超时。被应答的对话框会附在下一次工具结果的末尾，例如 `(dialog handled automatically: confirm("sure?") — accepted)` —— 不会悄悄吞掉。要改成 dismiss，见下面的 `dialogBehavior`。

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

空闲回收（idleMs = 2500ms）
  用完当下                    子进程存活
  4 秒后                      进程已退出，host.child = null
```

## 已知边界

- **只覆盖浏览器里的东西。** 本地软件的窗口和控件不在这一版范围内，那是桌面平面的活（见 Roadmap）。
- **私有 profile 是全新的。** 它没有你日常浏览器的 cookie 和登录态，需要登录的站点得在它里面登一次；登录态会保存在 `<DSH_HOME>/dsh-computer-use-bg/profile`，下次复用。
- **CDP 端口是本机回环。** 默认只监听 `127.0.0.1`。要远程用，别直接暴露，走 SSH 隧道。
- **`--headless` 下部分站点会识别出无头浏览器。** 默认就是无窗口，遇到硬性反爬的站点可临时把 `headless` 设成 `false` 再试一次。
- **无窗口就意味着你看不到过程。** 想确认它点了哪儿，用 `browser_snapshot`（默认带截图，只是它落在对话里而不是屏幕上）；想全程盯着看，把 `headless` 改成 `false`。
- **空闲会自动关闭。** 默认 5 分钟无操作后杀掉浏览器进程，下次调用重新拉起（冷启动约 7 秒）。要常驻就把 `idleMs` 设成 `0`。
- **`browser_eval` 能执行任意 JS。** 只在你信任的页面上用。
- **`browser_hover` 的「新出现了什么」靠对比两次元素快照。** 画在 canvas 里、或者只改了自己尺寸而没有新 DOM 元素的弹层（少数老式编辑器）看不到，这时候改用坐标 + 截图判断。
- **拖拽只覆盖页面内部的元素。** 把资源管理器里的文件拖进网页还不支持（见 Roadmap）。

## Roadmap

- [x] **对话框**（`alert` / `confirm` / `prompt`）：打开即自动应答并写进结果，页面不会再被卡死
- [x] **`browser_wait`**：等元素 / 文字 / 消失 / 加载完成，替代固定 sleep
- [x] **`browser_nav`**：reload / back / forward，到边界明确报错
- [x] **`browser_upload`**：给隐藏的 `<input type="file">` 直接塞文件
- [x] **hover / 右键 / 拖拽**：`browser_hover` 报出新出现的元素；右键走 `browser_click {button:"right"}`；`browser_drag` 同时覆盖 pointer 型和原生 HTML5 拖拽
- [ ] **桌面平面**：UIA 控件树（文本，不用截图）+ 隔离桌面（`CreateDesktop`）里跑真实输入，让本地软件也能操作而不抢前台 —— 这是 `@copylee` / `windows-mcp` 那套做不到的
- [ ] iframe / 跨域 frame：现在只能看到主框架，嵌入的支付、编辑器、验证码读不到
- [ ] 多标签页管理（`Target.createTarget` + sessionId 复用）
- [ ] 从**系统**拖文件进页面（`Input.dispatchDragEvent`）：现在能拖页面里的元素，还不能把资源管理器里的文件拖进 drop zone
- [ ] 下载落盘（`Browser.setDownloadBehavior`）
- [ ] 元素截图裁剪（只发目标区域的图，省 token）

## 开发

```bash
node tests/load.mjs           # 离线：按 DSH 的严格契约复刻注册校验（改动后先跑这个）
node tests/tools.mjs          # 工具接线：每个返回值都用自己的 output.schema 校验一遍
node tests/idle.mjs           # 空闲回收：进程确实会退出
node tests/smoke.mjs          # CDP 层端到端：点击/输入/键盘/截图/等待/对话框/上传/前进后退
node tests/live.mjs           # 真实站点：导航 + 点击跳转
node tests/live.mjs https://github.com
```

`tests/schema.mjs` 是宿主那两个 schema 校验器的唯一副本，`load.mjs` 和 `tools.mjs` 共用它。

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

## License

MIT
