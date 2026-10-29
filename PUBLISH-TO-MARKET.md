# 提交 hermes-panel 到 DSH 插件市场

**这份文件是给一个新会话用的。** 原定任务挂在一个旧会话上，那个会话要关掉了。

**新会话里只需要说一句：**

> 读 `E:\Harness\dsh\plugins\hermes-panel\PUBLISH-TO-MARKET.md`，按它做。

---

## 什么时候做

**仓库满 24 小时之后。**

```
GitHub 仓库创建时间  2026-10-15T08:18:27Z
满 24 小时         2026-10-16T08:18:27Z = 北京时间 16:18
建议动手            北京时间 16:30 之后
```

**早于这个时间提交，CI 会拒（市场的硬规则：仓库需满 1 天）。**

---

## 前置检查（先做，10 秒）

```bash
curl -s https://api.github.com/repos/GuanYang14700/dsh-hermes-panel
```

确认三件事：

- `created_at` 距今 ≥ 1 天
- `private` 为 `false`
- `default_branch` 为 `main`

```bash
curl -s https://raw.githubusercontent.com/GuanYang14700/dsh-hermes-panel/main/package.json
```

确认 `dsh.bundle` 存在 —— 市场靠这个判断可安装性。

```bash
gh auth status
```

确认仍登录 `GuanYang14700`。

---

## 提交

源文件：`E:\Harness\dsh\plugins\hermes-panel\market-entry.yml`

目标：`data/plugins/GuanYang14700__dsh-hermes-panel.yml`（**一个文件就是全部投稿**）

```bash
cd E:/Harness/dsh/home
rm -rf .market-submit && mkdir .market-submit && cd .market-submit
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone --remote
cd awesome-dsh-plugin
git checkout -b add-hermes-panel
cp E:/Harness/dsh/plugins/hermes-panel/market-entry.yml data/plugins/GuanYang14700__dsh-hermes-panel.yml
```

**市场只认这几个字段：**

```yaml
url: https://github.com/GuanYang14700/dsh-hermes-panel
name: GuanYang14700/dsh-hermes-panel
category: ui
description:
  en: '...'    # 必填
  zh: '...'    # 可选
```

**`market-entry.yml` 里如果还有别的字段（比如 `tarball:`），只保留上面这些。**

**`description` 里含「`: `」（冒号加空格）的值必须加引号** —— 否则 YAML 解析失败。

```bash
git add data/plugins/GuanYang14700__dsh-hermes-panel.yml
git commit -m "Add GuanYang14700/dsh-hermes-panel"
git push -u origin add-hermes-panel
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add GuanYang14700/dsh-hermes-panel" \
  --body "A Hermes panel for DSH. Repo: https://github.com/GuanYang14700/dsh-hermes-panel"
```

---

## 收尾

1. **把 PR 链接报给用户**
2. **清理 `E:/Harness/dsh/home/.market-submit`**
3. **提醒用户：合并后任何人在 DSH 里搜 `hermes` 就能找到它**
4. **如果失败**（仓库太新 / 权限 / lint 不过）—— **把确切原因和下一步说清楚，不要含糊**

---

## 背景（免得重新查）

| | |
|---|---|
| **npm 已发布** | `@yang3333/dsh-hermes-panel@1.1.0-rc.2` |
| **插件 id** | `hermes-panel` |
| **右栏标签 / 卡片** | `Hermes` / `Hermes 面板` |
| **市场收录要求** | 仓库声明 `dsh.bundle`、仓库满 1 天、`awesome-lint` 通过 |

**市场条目已经准备好的内容：**

```yaml
description:
  en: 'A Hermes panel for DSH: point it at a runtime and a data directory, and it starts and stops the Hermes gateway and dashboard, runs the health script Hermes ships itself, and carries the DSH <-> Hermes bridge. Both directories are settings — nothing is guessed and no machine path is hard-coded.'
  zh: '把 Hermes 放进 DSH 的侧边栏：给它两个目录——运行时和数据目录——它就来启停网关与 dashboard、跑 Hermes 自带的体检脚本，再捎上 DSH ↔ Hermes 的桥。两个目录都是设置项，不猜路径，也不写死任何一台机器。'
```

---

## 一件事值得留意

**`1.1.0-rc.1` 是坏的**（它依赖自己，装不上），已经标记为 deprecated。
**当前版本是 `1.1.0-rc.2`**，`latest` 和 `rc` 都指向它。

**提交市场时，仓库里的 `package.json` 必须是 rc.2 那份** —— 镜像已经同步过（commit `c26d93a`）。
查一下确认：

```bash
curl -s https://raw.githubusercontent.com/GuanYang14700/dsh-hermes-panel/main/package.json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log(m.version, JSON.stringify(m.dependencies??{}))})"
```

**应该是 `1.1.0-rc.2 {}`** —— 版本对、`dependencies` 空。
