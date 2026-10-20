# dsh-hermes-panel

中文 | [English](README.md)

把 Hermes 放进 DSH 右侧栏：启停网关和 dashboard，聊天旁边就能看 dashboard，再把 DSH 和 Hermes 接起来。

只针对原生 Hermes（`hermes-agent`），不是 `hermes-web-ui` / Ekko Studio。

## 面板

右侧栏 ⊕ 列表 →「打开 Hermes」。顶部一行图标切三个视图，同一行还有启动/停止、重启、在新标签打开：

- **仪表盘**：iframe 里的 Hermes dashboard，左边照常对话。
- **记录**：Hermes 与 DSH 的往来消息，读 DSH 自己的会话日志。
- **设置**：体检、升级、DSH 桥、共享工作区。

体检和升级跑的是 `official-web` 发行版自带的 PowerShell 脚本。pip 装的上游 Hermes 没有这些脚本，这两个按钮会禁用并说明原因；其余功能任何装法都能用。

## 安装

```sh
dsh plugin --profile web add @yang3333/dsh-hermes-panel
```

装完重启 `dsh`：Host 半是 Node 模块，刷新页面不会重新加载。

需要 DSH `>= 0.2.0-rc.2`，以及已经装好的 Hermes（插件不负责装 Hermes，只负责找到它，或者由你告诉它在哪）。仅支持 Windows。

## 设置

两个目录，都可以留空，留空用 DSH home 下的默认值：

- **运行时**：Hermes 跑在哪个 Python 环境。默认 `<dsh home>/hermes-panel/runtime`。
- **数据目录**：`HERMES_HOME`，放 profiles、会话、`config.yaml`。默认 `<dsh home>/hermes-panel/home`。

其余：`dashboardPort`（0 = 读 `.env`，否则 9150）、`sharedWorkspace`、`manageGateway`、`autostart`。

在侧边栏的「插件」面板 → Official →「Hermes Panel settings」里改。

## 桥

打开 DSH 桥后，面板会写 Hermes 侧的配置（`mcp_servers.dsh`）到 `config.yaml`，并检查每个 profile 的 `@deepseek-ai/dsh-mcp-client` 是否和当前 DSH 一致；不一致会给出修复命令。

## 安全

HTTP 路由只监听回环地址，校验 `Origin` 和 `Sec-Fetch-Site`。解析 `.env` 只保留 `HERMES_HOME`、`VENV`、`HERMES_EXE`、`DASHBOARD_PORT`，其余不落任何地方。插件启用时不要把 DSH 绑到 `0.0.0.0`。

## 开发

```sh
npm test          # 无副作用，Hermes 开着也能跑
npm run test:e2e  # 真跑脚本和真实 dashboard
```

测试在 `verify/` 下，一个文件一块，文件头写了它防的是什么回归。`verify/smoke.mjs` 用空配置加载 Host 半，确认注册 **17 条路由**，激活时不启动任何进程，再在没有 Hermes 的情况下调一次状态接口。`verify/config.mjs` 确认配置的 **6 个字段** 全部是 volatile、激活后保存的值就是面板读到的值，以及 `.env` 只保留四个白名单键。

## 许可

MIT
