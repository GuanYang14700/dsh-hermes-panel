# `@guanyang14700/dsh-hermes-panel`

把**原生的 Hermes** 放进 DSH 侧边栏：在面板里启停**消息网关**，并嵌入**原生 dashboard**。

包名 `@guanyang14700/dsh-hermes-panel`。**公开镜像仓库**：<https://github.com/GuanYang14700/dsh-hermes-panel>（npm 的 repository 指向它）；本机的开发副本在 `E:\Harness\dsh\plugins\hermes-panel`（私人库 `GuanYang14700/dsh`），两边用 `scripts/mirror-to-github.mjs` 同步。

> **`1.1.0-rc.1` 是**有意**先发出来的测试版**：上 npm、进插件市场，是为了让「装它的人不是作者」这件事尽早发生——只有这一种测试能钓出有意思的 bug。安装方式和正式版一样，版本号自己会说明身份。

## 先说清楚这是什么、不是什么

第一版实现把 `hermes-web-ui`（npm 包，品牌叫 **Ekko Studio**，EKKOLearnAI 出品）当成了
"用户的 Hermes"——那是错的。Ekko 以前的名字恰好就叫 **Hermes Studio**，所以极容易认错
（Hermes 自己的技能库里 `hermes-home-hygiene/references/ekko-studio-injection.md` 记录过这个
名字碰撞事故）。

**本插件针对的是原生 Hermes**（Python `hermes_agent`）——不管是 `pip install hermes-agent`
装在 `~/.hermes` 的那种，还是带 `official-web/`（`.env` 驱动的启动/维护脚本）的发行版。
下面这套命令和端口两种装法都一样：

| 组件 | 命令 | 端口 |
|---|---|---|
| 消息网关 / cron 调度器 | `hermes gateway run` | — |
| 原生 Web dashboard | `hermes dashboard --tui --host 127.0.0.1 --port 9150 --no-open --skip-build` | **9150** |

有 `official-web\.env` 时，配置值全部对齐它（`HERMES_EXE` / `HERMES_HOME` / `DASHBOARD_PORT`）；
没有时按 `config.yaml` 认家目录、按 PATH 上的 `hermes` 认命令。

**体检 / 查更新 / 升级** 这几个按钮跑的是 `official-web/` 里的 PowerShell 脚本。
上游那种 pip 安装没有这几个脚本，也没有对应的 `hermes-agent` 子命令可以替代，所以面板会**把这两个
禁用并说明原因**，而不是给一个按下去就报错的按钮。其余功能（启停、dashboard、记录、桥、共享工作区）
任何装法都可用；`GET /hermes/api/status` 用 `capabilities` 报出这套能力。

## 怎么接进来的

profile（`home\profiles\web\package.json`）用 `link:` 指向本目录，靠
`home\profiles\web\node_modules\@local\dsh-hermes-panel` 的 **junction** 生效。

> 不要直接手改 profile 的 `package.json`——用 `dsh plugin` 或插件管理器，
> 否则 junction 与依赖会脱节。改完 `index.js`（Host 半）**必须重启 DSH 进程**，
> 只刷新浏览器不会重新加载模块。

## 装上之后

**右侧栏多一个 `Hermes` 标签**——从 ⊕ 列表里的「**打开 Hermes**」进去。它有三个视图，
由标签栏上的一行图标切换（当前视图高亮，鼠标悬停出名字）：

| 图标 | 视图 | 里面是什么 |
|---|---|---|
| 🌐 | **仪表盘** | 原生 Hermes dashboard（iframe）。**左边 DSH 对话、右边 Hermes，同屏看** |
| 💬 | **记录** | Hermes ↔ DSH 的交流记录，从 DSH 自己的会话日志读；每条标着它在哪个目录跑的 |
| ⚙ | **设置** | 体检与升级 · DSH 桥 · 共享工作区 |

同一行还有：**启动/停止**、**重启**、**↗ 在新标签打开**。

**左侧栏没有 Hermes。** 这个插件不在那里注册任何东西——一个面，在它有用的地方。

`Hermes` 标签**不属于任何会话**，所以它跟着对话视图走：切会话不丢，切标签不重载页面
（iframe 永远不离开文档，只是被藏起来）。

图标用的是 **dashboard 自己那个 favicon**（`hermes_cli\web_dist\favicon.ico` 的 48×48 帧）——
也就是你浏览器标签上看到的同一张侧脸，这样侧边栏和网页里是同一个形象。

两个处理细节：

- **以 base64 data URL 内联进 `client.js`**。client bundle 是单文件服务的，外链图片没有稳定基准路径。
- **保持圆角方形，不做圆形裁切**。这张图自带不透明白底 + 黑色线稿，四角本来就透明，
  所以在深色侧边栏上是「一个白色小圆角方块」——正是浏览器标签的观感，不需要额外加底衬；
  而用 `border-radius:50%` 会把头顶和肩膀切掉。

> 早先误用过 `official-web\assets\hermes-official.ico`——那是**正面戴耳机**的头像，
> 不是你要的侧脸。换图时注意别拿错。

## 为什么不需要网桥

原生 dashboard 是普通 uvicorn 应用，**对首页和静态资源都不设 `X-Frame-Options`，也不设 CSP**
（`verify\host.mjs` 会断言这一点）。所以 DSH 页面可以直接 iframe `http://127.0.0.1:9150/`，
**本插件里没有任何反向代理**——这同时免掉了手写 WebSocket 隧道。

## 配置：运行时 + 数据卷

**这里不写死任何跟本机有关的东西，也不猜。** 只问两个目录：

- **运行时** —— Hermes 跑在哪个 Python 环境里（它的 `VENV`）。留空 = `<DSH home>/hermes-panel/runtime`。
- **数据目录** —— `HERMES_HOME`：profiles、会话、state、`config.yaml`、`official-web/`。
  留空 = `<DSH home>/hermes-panel/home`。

**两者互相独立，这是故意的**：数据目录指向你现成的 Hermes，会话和密钥就都还在；
运行时要换哪个 Python 就换哪个。两样都没有的机器，插件在 DSH home 下各建一个。

唯一会被"猜"的是环境变量 `HERMES_HOME` —— 那是 Hermes 自己的变量，排在设置之后。

> **早先的版本会去翻文件系统找同级的 `Hermes`** —— 一串祖先目录、用户主目录、几种带点的拼法 ——
> **那一整套就是 bug 本身。** 插件被装进 profile 的 `node_modules` 之后，它在很深的层级里，
> 往上找永远差一层：于是它说"没找到"，而 Hermes 正在旁边跑着，面板的启动按钮也没了。
> 现在换成两个写明白的目录，**每次失败都会说清是哪个目录、为什么不行。**

命令入口按这个顺序找：运行时目录 → `official-web/.env` 里的 `HERMES_EXE` → **PATH 上的 `hermes`**。
一个都没有时，目录**仍算找到了**：面板能看状态、能改设置、能配桥，
只是会明说「运行时目录里没找到 python / hermes」。



### 字段

这 7 个字段同时也是 profile patch 里的字段（设置页保存时写的就是它）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `runtimeDir` | `''` | 运行时：Python 环境（Hermes 的 `VENV`）；空 = `<DSH home>/hermes-panel/runtime` |
| `dataDir` | `''` | 数据目录：`HERMES_HOME`；空 = `<DSH home>/hermes-panel/home` |
| `dashboardPort` | `0` | `0` = 用 `.env` 的 `DASHBOARD_PORT`，取不到用 9150 |
| `sharedWorkspace` | `''` | 两边都在里面开工的目录；留空 = 不做共享。Hermes 的 `terminal.cwd` 指向它 |
| `manageGateway` | `true` | 是否连网关一起启停 |
| `autostart` | `false` | DSH 启动时是否自动拉起 Hermes |

**设置页还会报告数据卷里有什么** —— 哪几个 profile、state 多大、有没有 `official-web`。
路径对了和路径错了在文本框里长得一样，所以证据得印在旁边。

## 为什么设置页要自己注册

DSH **不会**根据插件的 `Config` schema 渲染表单。导出带 volatile 字段的 schema 只是让宿主**服务**
这个设置命名空间——`settings.describe()` 会给它返回一份表单、写入会被校验、profile patch 能设置它——
但界面不会自动生成。DSH 里每一个设置页都是**由拥有它的插件的 client 半自己贡献**的：
比如官方那个「终端」页就是一个独立的伴生包。

所以本插件在宿主服务该命名空间期间（`configForms.whileServed`），**同时注册进「插件」页声明的三个 slot**：

| slot | 落在哪 | 键 |
|---|---|---|
| `plugins.item` | 「**官方**」分组里、官方 bundle 旁边的一张**卡片** | profile 条目 id：`hermes-panel` |
| `plugins.bundle.config` | **本 bundle 自己详情页上的表单** | bundle 的包名 |
| `plugins.row.config` | bundle 的行页上的表单 | `bundle#rowId` |

**只填第一个，正是本插件犯过的错。** 插件页只在**有人用该 bundle 的包名注册了
`plugins.bundle.config`** 时，才渲染 bundle 的配置区
（`configured: ledger.bundles.has(openPkg.name)`）——所以只注册 `plugins.item` 的插件，
会在「官方」里放一张卡，而用户真正会落到的那一页（**点开已安装 bundle 的那一页**）**是空的**。
现在三个面渲染同一个组件：面板用 `{ view: 'page' }` 打开正文、用 `{ view: 'summary' }` 取卡片上那一句话。

`verify/client.mjs` 会像 slot 主人那样**逐个触发注入**，再检查注册、键、以及三个面是否都渲染出了表单——
**一个测试从不触发的注入，就是一个不会落地的注册**，这个缺口当初就是这么漏过去的。
它同时交叉校验控件**恰好覆盖**宿主 schema 声明的字段。

这个页面是**软依赖**：`configForms`、`locale` 和表单原语都是在 apply 时查找的，
缺少它们的部署会得到一个「没有设置页的 Hermes 面板」，而不是「没有插件」。

## 接口

**所有路由都要求**：对端地址是环回、`Origin` 同源（有则必须匹配 `Host`）、`Sec-Fetch-Site` 不是跨站。
`webServer.register` 本身不走 DSH 的 index/`/api` 鉴权，路由接口也没有 auth 选项；早先只判断 method，
于是**任何网页都能对 `/hermes/api/stop` 发一个免预检的 POST 把用户的 Hermes 杀掉**（CSRF）。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/hermes/api/status` | GET | 廉价轮询：只做端口探测 + 缓存状态，**不 spawn 任何进程** |
| `/hermes/api/start` | POST | 起网关（若未在跑）→ 起 dashboard → 等端口 |
| `/hermes/api/stop` | POST | 停 dashboard（含端口兜底）→ 停网关 |
| `/hermes/api/restart` | POST | stop → start |
| `/hermes/api/refresh` | POST | 唯一会 spawn `hermes cron status` 做实时网关检测的路由；同时重跑发现流程 |
| `/hermes/api/health` | GET | 跑 Hermes 自己的 `official-web\doctor.ps1 -Json`，原样返回它的报告 |
| `/hermes/api/update/check` | POST | 跑 `check-update.ps1`：已装版本 vs PyPI 最新版，以及新版是否匹配本机 Python。**不改任何东西** |
| `/hermes/api/update/apply` | POST | 先停 Hermes，再**在后台**启动 `update.ps1 -Apply`；任务在跑时重复调用是幂等的 |
| `/hermes/api/update` | GET | 升级任务：阶段、退出码，以及捕获到的输出 |
| `/hermes/api/bridge` | GET | DSH ↔ Hermes 桥的两半状态 |
| `/hermes/api/bridge/apply` | POST | 写入或刷新 Hermes `config.yaml` 里的 `mcp_servers.dsh`（先备份） |
| `/hermes/api/workspace` | GET | 共享工作区：目录、里面的 `AGENTS.md`、Hermes 有没有指过来、以及它有没有进侧边栏 |
| `/hermes/api/workspace/apply` | POST | 创建目录和 `AGENTS.md`，把 Hermes 的 `terminal.cwd` 指过来，**并把目录注册成侧边栏工作区** |
| `/hermes/api/workspace/register` | POST | 只做注册这一步（幂等）；面板在「目录已存在但还没进侧边栏」时自动调它 |
| `/hermes/api/workspace/sessions` | GET | 共享工作区里的会话记录列表（按 cwd 过滤 `sessionQuery` 的语料） |
| `/hermes/api/workspace/session?id=` | GET | 展开其中一条：任务、DSH 的回答、工具调用，按日志顺序 |
| `/hermes/api/pick-directory` | POST | 打开宿主机自己的目录选择框，返回选中的路径 |

### 共享工作区与共享上下文

「**DSH 桥**」面板里也带着共享工作区。填好 `sharedWorkspace` 再按「**创建并指向**」，会做三件事，每件单独汇报：

1. 确保目录存在；
2. 在**文件不存在时**才写 `AGENTS.md` —— 已存在的那份是操作者自己的，**绝不覆盖**；
3. 把 Hermes 自己的 `terminal.cwd` 指到这个目录，走的是和桥条目同一套「先备份、再由 `hermes config check` 裁定」的路径。

**这里没有任何格式转换，而这正是它能成立的原因。** 两边本来就认同一个文件：

| 哪边 | 去哪找 |
|---|---|
| DSH | `@deepseek-ai/dsh-agent-instructions` 读 `AGENTS.md`（还有 `CLAUDE.md`） |
| Hermes | `agent_init` / `prompt_builder` / `runtime_cwd` 读 `AGENTS.md` |

所以「共享上下文」不是一个同步问题，而是一个**目录问题**：把 `AGENTS.md` 放在两边都会打开的目录里，两边就都会读它。Hermes 那一半靠的是 `terminal.cwd` —— `runtime_cwd.py` 里写明 `TERMINAL_CWD` 就是配置项 `terminal.cwd` 的运行时载体；插件在该键不存在时创建它、存在时替换它，**不动 `terminal:` 块里的其他键**。

两半是分开汇报的，因为它们坏起来也是分开的：目录和文件是一回事，Hermes 有没有真的指过来是另一回事。

**「选择目录…」走的是宿主机自己的目录选择框**，不用手打路径。必须由宿主机弹：
浏览器会隐藏 `<input type="file" webkitdirectory>` 的绝对路径，前端根本拿不到一个可用的路径。
宿主机用 `powershell -STA` 拉起它（这些通用对话框要求单线程套间），选中的路径再通过
设置表单自己的 `edit`/`save` 写回去——所以它和手填的值走同一套校验，也会出现在设置页里。
取消不是错误；而这台机器如果没有可用的桌面会话，会得到一句指向「直接填路径」的提示。

**共享工作区就是桥的工作区**：它是一个目录，不是两个。以前 `bridgeWorkspace` 能覆盖它，
结果是面板说「共享」而桥其实跑在别处 —— 那正是把文件送进错目录的那个坑。

### 为什么"选完共享工作区啥也看不到"，以及现在能看到什么

这个目录里其实**只有 `AGENTS.md`**：它承载的是"共享上下文"，而一次交流的痕迹根本不在文件里——它在 DSH
自己的会话日志里。Hermes 每次用 `dsh_run` 驱动 DSH，都是一次真实的 `dsh --json` 运行，`cwd` 就是这个共享
工作区，于是那轮交流已经作为一条完整会话落盘了。问题只在于**它没有归属**：DSH 的工作区列表按"规范化 cwd"
分组的，而这个目录从没被登记成一个工作区，所以那条会话哪儿都不显示。

所以现在做两件事：

1. **把目录注册成工作区。** 「创建并指向」顺带调 `ctx.workspaceRegistry.create(path, '共享工作区（Hermes ↔ DSH）')`，
   幂等——注册表对同一个规范化路径只会复用已有记录。目录一旦登记，**该 cwd 下的所有会话就会出现在侧边栏**
   这个节点下面。`sharedWorkspace` 存好且目录存在时，面板还会自动补注册一次，不用你再按一次。
2. **记录在同一个 `Hermes` 标签的「💬 记录」视图里。** 进法：右侧栏 ⊕ → 「打开 Hermes」→ 点 💬。
   它列出 DSH 跑过的会话（时间、标题、进行中/已结束，**以及它在哪个目录跑的**），点开一条就是那一轮的
   对话——Hermes 发过去的任务、DSH 的回答、中间的工具调用，按日志顺序。切到记录时会自动展开最新那条。

   **记录不再按目录过滤。** 它以前只留 `cwd === 共享工作区` 的会话，而 Hermes 是从**它自己的工作区**
   驱动 DSH 的——于是你刚看着发生的那次交流被藏在了隔壁目录里，列表空空如也。现在全都列出来，
   不在共享目录的那条会把 `cwd` 标成另一种颜色。

顺带说明**为什么加不到"添加工作区…"菜单里**：那个入口的插槽 `sidebar.workspaces.directoryFlow` 是
`kind: 'single'`，已经被 DSH 自带的目录选择器占满，插件无法往菜单里再塞一项。但不需要塞：侧边栏的分组依据
是"谁拥有这个规范化目录"，注册才是真正的开关。

记录列表用的是 `ctx.sessionQuery`（`dsh-base` 挂载的 `session-query-sqlite`，`openAt: never`——
精确读取和语料列举可用，全文检索不可用，而本插件只需要前者）。这也是**为什么它不在状态轮询里**：列举语料是
存储操作，不该挂在 3 秒一次的心跳探测上。

### DSH ↔ Hermes 桥

这个通道的两个方向**都是 MCP**，但两端是反的：

| 方向 | 机制 |
|---|---|
| DSH → Hermes | DSH 的 `@deepseek-ai/dsh-mcp-client` 挂 Hermes 自己的 MCP 服务端 |
| Hermes → DSH | 本插件自带 `bridge/dsh_mcp_server.py`，Hermes 在 `mcp_servers.dsh` 里列它 |

插件拥有的是 **Hermes 这一半**：打开「**DSH 桥**」会报告状态，并可以把它写成指向**本插件包里那份**，而不是某个别的检出留下的路径。

写入**刻意很小心**。`config.yaml` 里放着运行时的**明文 provider key** 和一整批说明注释，所以它是**逐行**改写的，不是解析后重排——YAML round-trip 会把两者静默丢掉。写之前先备份；写之后必须过 `hermes config check`，不过就从备份恢复。`verify/bridge.mjs` 把这条钉死了，包括逐字节断言：无关注释、密钥、相邻的服务器条目都必须原样还在。

**DSH 那一半也会被报告，而它才是通常坏掉的那一半。** 当某个 profile 解析到的 `@deepseek-ai/dsh-mcp-client` 与运行时版本不一致时，DSH 会**禁用该 profile 的全部 MCP 行**——它只在日志里说一句就继续跑，于是工具就那么消失了。面板会读每个 profile 解析到的版本，并把修复命令原样打出来：

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-mcp-client@<运行时版本>
```

> 它读的是 **profile 的** `node_modules`，不是 `dsh` 包里自带的那份。那是两棵不同的树；读自带的那棵会报出「版本正常」，而实际上行是被禁用的——这正是这个检查早先版本犯过的错。

### 自己装 Hermes

**本插件不安装 Hermes，也不尝试安装。** Hermes 的安装器住在检出里面，而检出是随部署而定的
——技能、记忆、维护脚本都跟着它走——所以不存在一个能指向所有用户的仓库。

按 Hermes 自己的文档把它装好，然后告诉面板它在哪：

| 设置 | 指向 |
|---|---|
| **运行时** | 跑 Hermes 的 Python 环境 —— 它的 `VENV` |
| **数据目录** | `HERMES_HOME` —— profiles、会话、`config.yaml`、`official-web/` |

两项都在面板的「设置」里，各带一个目录选择器，并且都会显示在那里找到了什么：
运行时显示 CLI，数据目录显示 profile 数量和 state 大小。**路径对了和路径错了在文本框里长得一样**，
所以证据印在旁边。

start / stop / restart 走同一把**串行锁**：并发调用会复用正在跑的那次，而不是再起一套进程。

### 体检

面板上的「**体检**」跑的是 `doctor.ps1 -Json`——**Hermes 自己的九项检查**，不是这个插件的判断——并把报告画在按钮栏下面。

它**刻意不进状态轮询**：一次要起一个 PowerShell 进程加一次 Hermes CLI 调用（实测约 4 秒），所以只在按按钮时跑，结果一直留着直到你点「收起」。

**这个按钮只在有 `official-web/doctor.ps1` 的地方存在。** 上游那种安装下，路由会回
`available: false` 加一句原因，报告里就写着为什么，而不是静默失败。

插件自己不拥有任何体检/安装/更新逻辑。`official-web\` 里本来就有 `doctor.ps1`、`install.ps1` 和 `update.ps1`（后者自带升级前快照、升级后 SHA256 比对和回滚命令），而且**它们跟着 Hermes 一起升级**，所以包装它们能让插件不至于和一个手写等价物一样，跟 CLI 的演进脱节。脚本名走**固定白名单**，绝不来自请求。

> 子进程的 `[Console]::OutputEncoding` 在跑脚本前被钉成 UTF-8。不钉的话，Windows PowerShell 会用 OEM 代码页写 stdout，检查项里的中文 detail（dashboard 那条提示里有个 `.bat`）到手就是乱码——这是实测出来的，`verify/health-e2e.mjs` 盯着它。

### 更新

「**检查更新**」跑 `check-update.ps1`——**只报告，不改任何东西**——并把输出给你看。发现新版时面板会给出「**升级到 X.Y.Z**」，并且**要按第二次确认**才会真的动手。

应用升级**不是一个请求，而是一个后台任务**，原因有三个：

- `pip install --upgrade hermes-agent` 要跑几分钟，为此挂住一个 HTTP 请求，比它取代的那个轮询更不体面；
- 面板需要**实时**看到任务的输出——因为失败时 `update.ps1` 的回滚命令就打印在那里；
- 任务的硬上限是 30 分钟，而且是**最后手段**。在 pip 装到一半时把它杀掉，正是把虚拟环境搞坏的方式；这个上限是为了别让卡死的子进程一直泄漏，不是正常路径。

**升级前会先停 Hermes，升完不会自动重启。** `update.ps1` 装进去的正是 dashboard 和 gateway 正在执行的那个虚拟环境，而在 Windows 上这些文件运行时被锁着——**对着活着的安装做升级，轻则失败**。本来在跑的东西是**故意**留成停止的：把一个刚升级完的 agent 自动拉起来，该是操作者的决定，而不是按一下按钮的副作用。任务会记下升级前有没有东西在跑，面板会告诉你。

面板里的版本比较是**解析 `check-update.ps1` 自己的输出**，而不是再去问一次 PyPI——那个脚本已经处理了镜像源、`requires_python`、「本机 Python 装不了新版」这些情况，再写一份就是第二个要跟着维护的实现。

## 三个实现约束（都是踩出来的）

**1. `hermes dashboard` 是包装器，不是服务器。**
它自己常驻，真正的服务进程（`python.exe`）是它的子进程，端口在那个子进程手上（实测 listener PPID == 包装器 PID）；服务进程自己还会为每个打开的聊天会话再起 TUI worker。

所以 `stop` 分两条路：

- **本面板自己启的**（有 handle）：`terminate()` 掉整棵范围，再等端口释放。
- **外面启的**（用户 `启动.bat` → `official-web\start.ps1`，或上一个 DSH 进程留下的）：没有 handle，就按**端口归属**找出 PID，`taskkill /PID <pid> /T /F` 连树一起结束。

> **别再指望 `hermes dashboard --stop` 兜底。** 2026-10-07 实测：9150 和 9260 两个 dashboard 都在跑时，`hermes dashboard --stop` 输出 `No hermes dashboard processes running.` 并 **exit 0**，什么都没杀。
>
> 两层原因，任一层都足以让它失效：
> 1. 它的 Windows 探测走 `wmic process get ProcessId,CommandLine`，而 Windows 11 已不再自带 `wmic`（本机 `C:\Windows\System32\wbem\wmic.exe` 不存在）——`_find_stale_dashboard_pids()` 捕获 `FileNotFoundError` 后直接返回空列表。
> 2. 就算 wmic 在，它的匹配模式是 `"hermes dashboard"`，而本机启动的命令行是带引号的 `"...\Scripts\hermes.exe" dashboard --tui ...`，中间隔着 `.exe"`，模式匹配不上。
>
> 它现在只作为最后兜底保留。

**2. 网关检测不能进轮询。**
`hermes cron status` 要起一个 Python 进程，放 3 秒轮询里太重。
所以廉价状态路由只做端口探测，实时网关检测走 `/hermes/api/refresh`。

**3. 网关状态文件不可信。**
`HERMES_HOME\gateway_state.json` 会过期——本机实测：文件里写 PID 25512、时间戳是四天前，
而真正在跑的网关是 14168。判定一律以 `hermes cron status` 的输出为准。

**4. 网关报告按「它说的是哪句话」来读，认不出的就是 `unknown`。**
那条命令只会打出固定几句，每句含义都不同：

| 那句话 | 含义 |
|---|---|
| `Gateway is running — cron jobs will fire automatically` | 健康 |
| `... cron ticker looks STALLED — no heartbeat for Ns` | 进程在，ticker 线程死了 |
| `... no tick has succeeded in Ns` | 两者都在，但每次 tick 都在失败 |
| `Cron provider: X — ...` | 外部 provider：**没有**进程内 ticker，也**没有** `PID:` 行 |
| `Gateway is not running — cron jobs will NOT fire` | 已停止 |

**只有最后一句代表「停止」。** 一句都对不上时报告为 **unknown** 并附上原文尾部，**绝不谎报停止**——
早先的版本只问「它说网关在跑吗」，答不出就写「已停止」，于是 CLI 一改文案、或者 stdout 代码页一乱，
一个活着的网关就被静默写成停止，面板还会劝你「启动」一个已经在跑的东西。
匹配用的标记里**刻意不含** `✓`、`⚠` 和破折号，这样解析只依赖措辞、不依赖子进程编码；
`PYTHONIOENCODING` 另外钉了 UTF-8。`verify\gateway-status.mjs` 覆盖全部五句话、
两条 `unknown` 路径，以及一行里多个 PID。

面板把两种 unknown 分开说：**无法识别**是「报告读不懂」，**未知**是「探测本身失败」。

**5. 外部的网关同样不能只杀一个 PID。**
`hermes` 也是**启动器**：`hermes.exe gateway run` 自己常驻，真正的 `python.exe` 网关是它的子进程，`gateway.pid` / `cron status` 里那个 PID 才是网关本身。
所以停外部网关的做法是：

1. 先跑 `hermes gateway stop` —— 它会先写「计划停止」标记让网关**优雅排空**在跑的 agent、把会话标成 `resume_pending`，再对它能看到的全部 PID 做有界强杀。裸 `process.kill()` 会跳过排空。
2. 再 `hermes cron status` 复查；还在跑就按 `PID:` 行里的**每一个** PID `taskkill /T /F`。
3. 再复查一次，仍然活着才报错。

（`cron status` 可能在**一行**里列多个 PID，旧代码只取第一个——本机实测这次只报了一个，但 pid 文件一旦过期，扫描出来的就不一定是网关本体。）

## 自检

`npm test` 跑 13 个（全部用一次性 Hermes 装置，不碰你的真实安装，可以随时跑）；
`npm run test:e2e` 那 4 个才是真起进程的（会真跑 PowerShell、真起停止 dashboard），它们和插件一样按两个目录去找（可用 `HERMES_HOME` 覆盖数据目录）。

| 脚本 | 用途 |
|---|---|
| `verify\smoke.mjs` | 空配置下模块能加载、注册 **17 条路由**、**激活时零副作用**；dashboard 在跑时也能安全跑 |
| `verify\client.mjs` | Client 半契约：两个座位、设置页（注册、注入的表单面、「控件恰好覆盖宿主 schema 字段」的交叉校验），以及面板的**体检按钮与报告渲染** |
| `verify\host-csrf.mjs` | **授权回归**：跨站 `Origin`、`Sec-Fetch-Site: cross-site`、非环回对端都必须 403——而且是**遍历每一条已注册路由**，不只测写死了用例的那几条 |
| `verify\config.mjs` | `Config` 能加载、**6 个字段**都是 `.volatile()`；运行时实时读取设置（激活之后保存的值也能读到、没有设置服务时的回退）；`.env` 解析只保留白名单键、**密钥不泄漏**；设置命名空间与 bundle 行 id 一致 |
| `verify\concurrency.mjs` | 三次并发 `start` 只起一个 dashboard，且锁在结束后会释放 |
| `verify\health.mjs` | 体检路由对着**桩 PowerShell**：子进程 argv、UTF-8 前导、越过 `[doctor]` 前缀定位 JSON、失败上报、`pwsh` → `powershell.exe` 回退 |
| `verify\health-e2e.mjs` | 同一条路由对着**真的 `doctor.ps1`**——实测桩测不到的那部分，包括中文 detail 能不能活着穿过真实的 PowerShell |
| `verify\update.mjs` | 升级任务：主机选定、`update.ps1 -Apply` 的 argv、重复启动的幂等、输出捕获，以及 done/error/重试的状态迁移。**故意从不真跑 `-Apply`**——那会改本机的 Python 环境 |
| `verify\bridge.mjs` | 桥的写入——本插件最危险的一次改写：无关注释、明文密钥、相邻服务器条目必须逐字节保留；`hermes config check` 失败必须从备份回滚；重复写入必须是空操作；缺失的 `mcp_servers:` 块要被正确创建而不是乱插 |
| `verify\gateway-status.mjs` | `hermes cron status` 能打出的**每一句话**，以及答案读不懂的**两条路径**（一句都对不上、CLI 起不来）。它存在的理由就是：这两条都不许被报成「已停止」 |
| `verify\bridge-server.mjs` | **服务端那一半**（此前没有自己的测试）：带引号、反斜杠、`%`、中文的任务必须作为**一个** argv 元素抵达 DSH（shell 再也看不到它）、续会话 id 去空白且顺序正确、截断保住头尾、失败提示仍然匹配、以及 DSH 版本只读一次并写进报告头一行。它还会在**屏蔽 `mcp` SDK** 的情况下导入本模块，确保容错导入一直有效 |
| `verify\bridge-render.mjs` | 桥渲染的 `dsh --json` 事件流：**让「接着干」成立的那个会话 id**、最终回答、工具调用变成轨迹行、**纯文本 stdout 绝不能被误判成事件流**、以及没有 `final` 时回退到 text 块。跑的是渲染器自己的 Python 自检，所以不需要 `mcp` 包、不起服务端 |
| `verify\package.mjs` | 打包与元数据审计：npm 与 DSH 会读的字段、`exports`/`files`/`main` 的每个目标都要真实存在、图标必须是真 PNG 且在 DSH 的 256 KiB 限制内、两个 locale 文件能解析且描述的是插件的真实范围、CHANGELOG 记了当前版本、**每个验证脚本都必须被某个 script 引用**、发布目录里不许有垃圾 |
| `verify\workspace-records.mjs` | 共享工作区的两半，对着**桩** `workspaceRegistry` 与 `sessionQuery`：注册才是让目录（以及该 cwd 下的所有会话）可见的那一步；注册幂等；组合里没有注册表时给出原因而不是崩；会话列表只留这个工作区的 cwd；一条日志能折成那一轮交流——Hermes 的任务、DSH 的回答、推理、一次工具调用（重复的 `tool/call` 事件被丢掉）和两条工具结果（失败那条被标成错误） |
| `verify\tmp.mjs` | 共用**助手**（不是入口）：先试系统 temp，那里拒绝建目录时回退到包内 |
| `verify\target.mjs` | e2e 脚本共用的「找到真实 Hermes」工具（**故意不复用插件代码**，否则发现逻辑的回归测不出来） |
| `verify\host.mjs` | 完整生命周期（面板**自己启**的 dashboard，走 `terminate()` 那条路）。默认独占 9150；真 dashboard 在跑时传个空闲端口即可照跑：`node verify/host.mjs 9266` |
| `verify\stop-foreign.mjs` | 回归测试：面板**没拥有**的 dashboard（外部启动）也能被 `/stop` 真正停掉。默认用 9260，不碰 9150；`node verify/stop-foreign.mjs <port>` 可换端口（注意 9151–9250 是 Windows 保留端口，绑不上） |
| `verify\stop-gateway.mjs` | 回归测试：面板**没拥有**的网关（外部 `hermes gateway run`）也能被 `/stop` 真正停掉，且用独立的 `hermes cron status` 复核。**会真的起一个网关再停掉**（约 1 分钟），跑之前确认当前没有网关在跑；dashboard 端口被指到一个空闲端口，不碰 9150 |
| `verify\client.mjs` 的写法 | 用桩 `window.__ModuleLoader__` + 假 React + 假 slot 注册表跑真实 `apply`；注意 bundle 里的 `fetch` 是**加载时**绑定的，之后改 `globalThis.fetch` 没用 |

## 安全边界

`webServer.register` 注册的路由**不走** DSH 的 index/`/api` 鉴权，路由接口本身也没有 auth 选项。
本插件因此自己做三层判断（环回对端 + 同源 `Origin` + `Sec-Fetch-Site`），挡住「任意网页用免预检 POST
把用户的 Hermes 停掉」这类 CSRF。剩下的面：能碰到回环端口的**本机**进程仍可读状态、启停 Hermes——
缓解因素是 dashboard 只绑 `127.0.0.1`（`verify\host.mjs` 会断言局域网地址拒绝连接），且它自带 session token。
**启用期间不要把 DSH 绑到 `0.0.0.0`。**

关于凭据：插件会读 Hermes 的 `official-web/.env`，但**只取 `HERMES_HOME` / `VENV` / `HERMES_EXE` /
`DASHBOARD_PORT` 四个键**，其余行（含 API Key）在解析阶段就被丢弃。密钥不进插件状态、不进日志环、
不进 `/hermes/api/*` 的响应。`verify/config.mjs` 会断言这一点。

## 语言

DSH 自己的客户端包都是**中英双语、运行时切换**的，本插件照做。文案分两个命名空间：

| 命名空间 | 界面 |
|---|---|
| `hermes-panel.panel` | 侧边栏面板——控制栏、体检、更新、安装、DSH 桥、共享工作区 |
| `hermes-panel.settings` | 设置页自己的表单 |

两个都注册给 locale 服务，并且在该服务不存在时**回退中文**——没装 locale 的部署照样能渲染，
这和 client 半的其余软依赖是同一条规则。

`verify\client.mjs` 钉住三条性质：

- **字典区域之外不许出现中文**——新加的文案不会漏翻；
- **两种语言的键必须一致**——缺键的地方会直接渲染成 key 本身；
- **字典的值不许调用 `t`**——第一次把这些字符串搬进字典的那趟脚本把字典自己也改了，
  每个值都变成对自己的调用，而这种错误**只在渲染时才炸**。

## 许可

MIT，见 [LICENSE](LICENSE)。
