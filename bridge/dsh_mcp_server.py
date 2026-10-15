#!/usr/bin/env python3
"""dsh_mcp_server.py — 把 DSH (DeepSeek Harness) 暴露成 MCP 服务端，让 Hermes 驱动它。

方向说明（两个桥是反的，别搞混）：

    DSH 侧的 dsh-mcp-client   DSH 是 MCP **客户端**  ->  DSH 调 Hermes 的工具
    本文件                    Hermes 是 MCP **客户端**  ->  Hermes 驱动 DSH 干活

本文件随 `dsh-hermes-panel` 插件一起分发。插件会把它写进 Hermes 的
`config.yaml`（`mcp_servers.dsh`），并把下面三个环境变量一并写进去，所以
**这里的默认值只用于手工运行**，插件运行时永远显式传入：

    DSH_MCP_ROOT       DSH 安装根（含 node_modules/@deepseek-ai/dsh 的那一层）
    DSH_MCP_WORKSPACE  Hermes 驱动 DSH 时，DSH 文件工具的相对根
    DSH_MCP_PROFILE    DSH profile；必须是**不挂** Hermes MCP 的那个，否则回环

为什么调 node 而不是 dsh.cmd：Windows 上 .cmd 必须经 cmd.exe 才能执行，而那会引入
一层命令行引号解析（任务文本里带引号/百分号就会出事）。这里直接用 node 跑 bin.js，
参数以列表传入、不经过任何 shell，等价于 dsh.cmd 做的事，但引号是精确的。

凭证：本服务端 **不** 传任何 key。DSH 自己会按 dsh-credentials-local 的顺序去找
（启动环境 → 存储文件 → 项目 .env → harness-home .env），最后一层就是
~/.dsh/.env。所以只要那个文件里有 DEEPSEEK_API_KEY，这里什么都不用做。

启动：  <python> dsh_mcp_server.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

# 渲染器拆在旁边的 dsh_events.py 里（只用标准库），这样它能在不装 mcp、不起服务端
# 的情况下被 verify/ 直接验证。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dsh_events import render_events  # noqa: E402

try:
    from mcp.server.fastmcp import FastMCP

    _MCP_IMPORT_ERROR: str | None = None
except ImportError as exc:  # pragma: no cover
    # Not fatal at import time: the helpers below are the half that can be
    # self-tested, and a test run should not need the SDK installed to check
    # them. Failing to build the server still fails loudly, in `main`.
    FastMCP = None  # type: ignore[assignment]
    _MCP_IMPORT_ERROR = (
        "需要 'mcp' 包（v1，提供 FastMCP）。装法：\n"
        "  <Hermes 的 python> -m pip install 'mcp<2'\n"
        "注意必须 <2：mcp 2.x 把 FastMCP 改名成 MCPServer，import 路径会直接抛错。\n"
        f"（真正的失败：{exc}）"
    )

# --------------------------------------------------------------------------
# 路径与默认值
# --------------------------------------------------------------------------

# DSH 安装根。插件运行时一定会设 DSH_MCP_ROOT；这里的回退只是给手工运行用，
# 不指向任何特定机器。
DSH_ROOT = Path(os.environ.get("DSH_MCP_ROOT") or (Path.home() / "dsh"))
DSH_BIN = DSH_ROOT / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"

# 默认工作目录：Hermes 驱动 DSH 干活时，DSH 的文件工具相对这里解析。
DEFAULT_WORKSPACE = os.environ.get("DSH_MCP_WORKSPACE") or str(Path.home())

# 默认 profile。绝不能是挂了 Hermes MCP 的那个，否则 Hermes -> DSH -> Hermes 回环。
DEFAULT_PROFILE = os.environ.get("DSH_MCP_PROFILE", "dsh-agent")

MAX_TIMEOUT = int(os.environ.get("DSH_MCP_MAX_TIMEOUT", "3600"))
DEFAULT_TIMEOUT = int(os.environ.get("DSH_MCP_TIMEOUT", "900"))

# 返回给模型的文本上限，防止一次任务把上下文撑爆。
MAX_OUTPUT_CHARS = int(os.environ.get("DSH_MCP_MAX_OUTPUT", "60000"))

mcp = FastMCP("dsh") if FastMCP is not None else None


def _tool():
    """`@_tool()` when the SDK is present, a pass-through when it is not.

    The pass-through is what lets this module be imported — and self-tested —
    without `mcp` installed, which is the only way the half of it that is not
    the SDK can be checked by a run that has no SDK.
    """
    return (lambda fn: fn) if mcp is None else mcp.tool()


def _log(msg: str) -> None:
    """诊断信息一律走 stderr —— stdout 是 MCP 协议通道，写一个字都会破坏协议。"""
    sys.stderr.write(f"[dsh-mcp] {msg}\n")
    sys.stderr.flush()


def _find_node() -> str:
    """复刻 dsh.cmd 的查找顺序：先看 dsh 目录下有没有自带 node，否则用 PATH 上的。"""
    local = DSH_ROOT / "node.exe"
    if local.exists():
        return str(local)
    found = shutil.which("node")
    if found:
        return found
    raise FileNotFoundError("找不到 node.exe（既不在 dsh 目录下，也不在 PATH 上）")


def _list_profiles() -> list[str]:
    profiles_dir = Path(os.environ.get("USERPROFILE", Path.home())) / ".dsh" / "profiles"
    if not profiles_dir.is_dir():
        return []
    return sorted(p.name for p in profiles_dir.iterdir() if (p / "package.json").is_file())


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    head = text[: MAX_OUTPUT_CHARS // 2]
    tail = text[-(MAX_OUTPUT_CHARS // 2):]
    return f"{head}\n\n... [中间省略 {len(text) - MAX_OUTPUT_CHARS} 字符] ...\n\n{tail}"


_DSH_VERSION: "str | None" = None
_DSH_VERSION_READ = False


def _dsh_version() -> "str | None":
    """The installed DSH version, read once from its package manifest.

    Reported on every run on purpose. The `--json` event stream this server reads
    is DSH-**internal** — it is not a versioned interface, and nothing about it
    promises to keep its shape. So after a DSH upgrade the worst failure is not a
    crash: it is a summary that quietly loses content. Having the version in the
    report makes that visible instead of silent.

    Read from the manifest rather than `dsh --version`: no subprocess, and it
    works while an upgrade is in progress.
    @returns the version string, or None when it cannot be read.
    """
    global _DSH_VERSION, _DSH_VERSION_READ
    if _DSH_VERSION_READ:
        return _DSH_VERSION
    _DSH_VERSION_READ = True
    manifest = DSH_ROOT / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    version = data.get("version")
    _DSH_VERSION = version if isinstance(version, str) and version.strip() else None
    return _DSH_VERSION


def _version_suffix() -> str:
    """`，dsh=0.2.0-rc.2` for the hand-written headers, empty when unreadable."""
    version = _dsh_version()
    return f"，dsh={version}" if version else ""


_JOURNAL_LOCK = threading.Lock()


def _journal_path() -> "Path | None":
    """Where to append one line per driven run.

    `DSH_MCP_JOURNAL` wins when it is set; the plugin writes it into Hermes'
    config so the two halves agree on the file without either guessing.

    It is no longer REQUIRED, and that is the point. Treating "unset" as "keep no
    journal" made the record depend on two coordination steps a user can miss — the
    plugin writing the variable, and Hermes being restarted so its MCP child picks
    it up. Both were missed, and a real run (`uuuuu.md`, session 4ec31c1d…) left no
    trace while the panel showed an empty list and no reason why.

    The default is the same path the panel reads, so a stale child still records and
    a fresh install works before anything is configured. Set the variable to move it.
    """
    raw = os.environ.get("DSH_MCP_JOURNAL", "").strip()
    if raw:
        return Path(raw)
    return Path.home() / ".dsh" / "hermes-panel" / "drives.jsonl"


def _record_run(session_id: str, task: str, cwd: str, profile: str, exit_code: int, dsh_version: "str | None") -> None:
    """Append one driven run to the journal. Never raises.

    A failed write must not fail the task it was recording: the journal is how the
    panel SHOWS what happened, and losing a line costs a row, not the run.
    """
    path = _journal_path()
    if path is None or not session_id:
        return
    line = json.dumps({
        "id": session_id,
        "task": task,
        "cwd": cwd,
        "profile": profile,
        "exit": exit_code,
        "dsh": dsh_version,
        "at": int(time.time() * 1000),
    }, ensure_ascii=False)
    try:
        with _JOURNAL_LOCK:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
    except OSError as exc:
        _log(f"journal write failed: {exc}")


def _build_argv(node: str, profile: str, task: str, session_id: str) -> list:
    """The exact argv for one run.

    Split out from the running of it because this is where the handling goes
    wrong and nowhere else can it be checked: the task text carries quotes,
    backslashes, percent signs and non-ASCII, and it has to reach DSH as ONE list
    element rather than being re-parsed by a shell.
    @param node - the node executable.
    @param profile - the DSH profile.
    @param task - the task text, verbatim.
    @param session_id - the session to resume, or empty for a new one.
    @returns the argv, ready for `subprocess.run(argv, shell=False)`.
    """
    argv = [node, str(DSH_BIN), "--profile", profile, "--json"]
    if session_id.strip():
        argv += ["--session-id", session_id.strip()]
    argv.append(task)
    return argv


def _failure_hint(stdout: str, stderr: str) -> str:
    """The most common DSH failures, translated into something actionable.

    Matched on DSH's own words rather than on an exit code, because the exit code
    is always 1 and the reason is only ever in the text.
    @param stdout - the run's stdout.
    @param stderr - the run's stderr.
    @returns the hint, or an empty string when nothing is recognised.
    """
    if "MISSING_CREDENTIAL" in stdout or "MISSING_CREDENTIAL" in stderr:
        return (
            "\n\n提示：这是凭证缺失。DSH 的查找顺序是 启动环境 -> 存储文件 -> 项目 .env "
            "-> harness-home .env。请在 ~/.dsh/.env 里加一行 DEEPSEEK_API_KEY=...\n"
            "（值可以从 Hermes 的 home/.env 抄。）"
        )
    if "does not exist" in stderr and "session" in stderr:
        return (
            "\n\n提示：续会话时 id 必须来自上一次 dsh_run 的「会话 id」那一行，"
            "而且格式是 `session-<uuid>`（带 `session-` 前缀）。"
        )
    # DSH 只肯在同一工作目录里续会话；换个目录就得新开一个。
    if "was recorded in" in stderr and "not" in stderr:
        return (
            "\n\n提示：DSH 不允许在不同工作目录下续同一个会话（换 cwd 就得重新 dsh_run）。"
        )
    if "not found" in stderr and "patch" in stderr:
        return "\n\n提示：profile 补丁里有条目被加载器跳过（通常是没写 insert:）。"
    return ""


def _run_dsh(
    profile: str,
    task: str,
    cwd: str,
    timeout_seconds: int,
    raw_json: bool,
    session_id: str,
) -> str:
    """跑一次 DSH，返回结构化文本报告（成功/失败都返回文本，不抛异常）。"""
    # --- 参数校验（尽量在启动进程前失败，并给出可操作的提示）----------------
    if not task.strip():
        return "错误：task 不能为空。"
    if not DSH_BIN.exists():
        return (
            f"错误：找不到 DSH 入口 {DSH_BIN}\n"
            f"检查 DSH_ROOT（当前 {DSH_ROOT}）。若 DSH 装在别处，给本服务端设 DSH_MCP_ROOT。"
        )

    available = _list_profiles()
    if available and profile not in available:
        return f"错误：profile '{profile}' 不存在。可用的：{', '.join(available)}"

    workspace = cwd.strip() or DEFAULT_WORKSPACE
    if not Path(workspace).is_dir():
        return f"错误：工作目录不存在：{workspace}"

    timeout_seconds = max(1, min(int(timeout_seconds or DEFAULT_TIMEOUT), MAX_TIMEOUT))

    argv: list[str] = _build_argv(_find_node(), profile, task, session_id)

    # 不设 shell：参数以列表传递，任务文本里的引号/反斜杠/百分号都是字面量。
    #
    # stdin 必须给 DEVNULL，这是个踩过的坑：本服务端自己的 stdin 是 MCP 协议管道，
    # 子进程若继承它，DSH 一读 stdin 就会吃掉协议字节并永久阻塞 —— 表现为
    # 「dsh_run 卡到超时，且 stdout/stderr 全空」，而同一个任务在命令行里 3 秒就跑完。
    kwargs: dict = dict(
        cwd=workspace,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
    )
    if sys.platform == "win32":
        # 避免弹出控制台窗口；输出仍被捕获。
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    _log(f"run profile={profile} cwd={workspace} timeout={timeout_seconds}s raw_json={raw_json} session={session_id.strip() or '-'}")

    try:
        proc = subprocess.run(argv, **kwargs)
    except subprocess.TimeoutExpired as exc:
        # 超时：subprocess 已经杀掉了进程。把已有的输出尽量还回去。
        partial_out = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
        partial_err = (exc.stderr or "") if isinstance(exc.stderr, str) else ""
        return _truncate(
            f"超时：{timeout_seconds} 秒内没跑完，进程已终止。\n"
            f"（长任务请调大 timeout_seconds，上限 {MAX_TIMEOUT} 秒）\n\n"
            f"--- 已产生的 stdout ---\n{partial_out}\n\n--- 已产生的 stderr（尾部）---\n{partial_err[-4000:]}"
        )
    except FileNotFoundError as exc:
        return f"错误：启动失败 {exc}"

    stdout = (proc.stdout or "").strip()
    stderr = (proc.stderr or "").strip()

    # DSH 把推理过程和各类警告都写 stderr，会很长；只回尾部，够定位问题。
    stderr_tail = stderr[-4000:] if stderr else ""

    # `--json` 的事件流是拿到会话 id 的唯一途径：`--session-id` 只能续不能新建，
    # 纯文本 stdout 里也没有它。拿到它，Hermes 才能在审核之后接着同一条会话干。
    rendered = render_events(stdout)
    if not session_id.strip() and rendered.session_id is None and rendered.parsed:
        _log("事件流里没有 sessionId —— 这次无法续会话")

    # One line per driven run, so the panel can tell the exchanges Hermes started
    # from the sessions a person typed into the CLI. The session store cannot: a
    # driven session and a handwritten one have byte-identical headers.
    _record_run(
        rendered.session_id or session_id.strip(),
        task,
        workspace,
        profile,
        proc.returncode,
        _dsh_version(),
    )

    if raw_json:
        # 调用方要的就是原始事件流，别替它渲染。
        return _truncate(stdout if stdout else "（事件流为空）")

    if proc.returncode == 0:
        if rendered.parsed:
            result = rendered.summary(profile, proc.returncode, MAX_OUTPUT_CHARS, _dsh_version())
        else:
            # 不是事件流（profile 不认 --json，或者 stdout 被别的东西占了）。
            # 退回纯文本，但说清楚拿不到会话 id，别让调用方以为可以续。
            body = stdout if stdout else "（stdout 为空）"
            result = (
                f"DSH 完成（退出码 0，profile={profile}{_version_suffix()}，cwd={workspace}）\n"
                f"会话 id: （这次没拿到，dsh --json 没有输出事件流，无法续会话）\n\n{body}"
            )
        if stderr_tail:
            result += f"\n\n--- stderr 尾部（推理/警告，通常可忽略）---\n{stderr_tail}"
        return _truncate(result)

    # 把最常见的失败翻译成人话
    hint = _failure_hint(stdout, stderr)

    partial = rendered.answer if rendered.parsed and rendered.answer.strip() else ""
    partial_block = f"\n\n--- 失败前已经产生的回答 ---\n{partial}" if partial else ""
    return _truncate(
        f"DSH 失败（退出码 {proc.returncode}，profile={profile}{_version_suffix()}，cwd={workspace}）\n\n"
        f"--- stdout ---\n{stdout}\n\n--- stderr 尾部 ---\n{stderr_tail}{partial_block}{hint}"
    )


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------


@_tool()
def dsh_run(task: str, cwd: str = "", timeout_seconds: int = 0, profile: str = "") -> str:
    """让 DSH 完成一个任务，返回它的回答 **和一个会话 id**。

    返回里会有一行固定格式的 `会话 id: session-...`。**把它记下来**：审核完 DSH 的产出、
    想让它接着改的时候，用 `dsh_resume(session_id=..., task=...)` 接同一条会话，
    这样它记得前面做过什么，不用把背景重讲一遍。

    典型用法（像带一个子智能体）：
      1. dsh_run 发第一个任务；
      2. 你审核回答；
      3. dsh_resume 带上会话 id 发整改要求；
      4. 重复 2–3 直到满意。

    注意：
    - 每次 dsh_run 都是**新会话**，不带当前对话历史，任务描述要自包含。
    - 默认 profile 是 dsh-agent（刻意不挂本机 Hermes 的 MCP，避免回环）。web / headless
      挂了 Hermes 的工具，除非你清楚在做什么，否则别换。
    - 默认在 DSH_MCP_WORKSPACE 下工作；要动别的项目就传 cwd。

    Args:
        task: 给 DSH 的任务，自然语言，尽量自包含（背景、要什么产出、在哪）。
        cwd: DSH 的工作目录。留空则用默认工作区。
        timeout_seconds: 超时上限，0 表示默认 900 秒。
        profile: DSH profile，留空即 dsh-agent。
    """
    return _run_dsh(profile.strip() or DEFAULT_PROFILE, task, cwd, timeout_seconds, False, "")


@_tool()
def dsh_resume(session_id: str, task: str, cwd: str = "", timeout_seconds: int = 0, profile: str = "") -> str:
    """接着一条已有的 DSH 会话继续干活（它带着之前那轮的上下文）。

    会话 id 来自上一次 `dsh_run` 返回里的 `会话 id: session-...` 那一行，**必须带
    `session-` 前缀**。传一个不存在的 id，DSH 会直接报 `does not exist` 而非新建会话。

    Args:
        session_id: 形如 session-xxxxxxxx-xxxx-... 的会话 id。
        task: 要继续做的事（比如「第 2 点不对，改成…」）。
        cwd: 工作目录，留空用默认。
        timeout_seconds: 超时上限，0 表示默认 900 秒。
        profile: DSH profile，留空即 dsh-agent。
    """
    if not session_id.strip():
        return "错误：session_id 不能为空（续跑需要它；只想跑新任务请用 dsh_run）。"
    return _run_dsh(profile.strip() or DEFAULT_PROFILE, task, cwd, timeout_seconds, False, session_id)


@_tool()
def dsh_run_json(task: str, cwd: str = "", timeout_seconds: int = 0, profile: str = "") -> str:
    """跑一个 DSH 任务，返回换行分隔的**原始运行事件流**而不是渲染后的报告。

    什么时候用它：想自己解析过程（每步耗时、工具调用、token 用量）时。
    输出比 dsh_run 大得多，而且第一行 `{"type":"session",...}` 里就是会话 id。

    Args:
        task: 任务文本。
        cwd: 工作目录，留空用默认。
        timeout_seconds: 超时上限，0 表示默认 900 秒。
        profile: DSH profile，留空即 dsh-agent。
    """
    return _run_dsh(profile.strip() or DEFAULT_PROFILE, task, cwd, timeout_seconds, True, "")


@_tool()
def dsh_profiles() -> str:
    """列出本机所有 DSH profile，并标出哪些挂了 Hermes 的 MCP。

    挂了的那些（web / headless）**不要**拿来给 Hermes 驱动 —— 会形成
    Hermes -> DSH -> Hermes 的回环。给 Hermes 用的是 dsh-agent。
    """
    profiles = _list_profiles()
    if not profiles:
        return "没找到任何 profile（看了 ~/.dsh/profiles）。DSH 装好了吗？"

    import re

    lines = []
    for name in profiles:
        patch = Path(os.environ.get("USERPROFILE", Path.home())) / ".dsh" / "profiles" / name / "cordis.patch.yml"
        mounts = False
        if patch.is_file():
            try:
                mounts = bool(re.search(r"dsh-mcp-client", patch.read_text(encoding="utf-8", errors="replace")))
            except OSError:
                pass
        tag = "  ← 挂了 Hermes MCP，别给 Hermes 驱动（回环）" if mounts else "  ← 可以给 Hermes 驱动"
        mark = " *" if name == DEFAULT_PROFILE else "  "
        lines.append(f"{mark}{name}{tag}")

    return "DSH profiles（* = 当前默认）：\n" + "\n".join(lines)


def _selftest() -> int:
    """离线自检：不起服务端、不联网、不跑 DSH。

    `verify/bridge-server.mjs` 就是跑这个。它覆盖的是这个文件里**不依赖 `mcp`
    的那一半**——也正是最容易被跳过、却最容易出错的一半：参数怎么拼、输出怎么
    截、失败怎么翻译成人话、版本怎么读。

    这里能跑起来，前提是顶部的 `mcp` 导入是容错的：没装 SDK 也能 import。
    """
    # --- argv：任务文本必须原样成为「一个」参数 ---------------------------
    # 引号、反斜杠、百分号、中文路径 —— 全是踩过的。
    task = '创建 "你好.md"，内容 50% 就行；路径 C:\\work\\demo'
    argv = _build_argv("node", "dsh-agent", task, "")
    assert argv[-1] == task, argv[-1]
    assert argv[0] == "node", argv[0]
    assert argv[2:5] == ["--profile", "dsh-agent", "--json"], argv
    assert str(DSH_BIN) in argv, argv
    assert "--session-id" not in argv, argv

    # 续会话：id 两侧的空白必须去掉，顺序必须是 --session-id 然后任务。
    resumed = _build_argv("node", "dsh-agent", task, "  session-abc  ")
    assert resumed[-3:] == ["--session-id", "session-abc", task], resumed
    assert resumed[-1] == task, resumed[-1]

    # --- 截断：短的别动，长的要保住头尾并说清省了多少 ----------------------
    assert _truncate("短") == "短"
    long_text = "A" * (MAX_OUTPUT_CHARS + 500)
    cut = _truncate(long_text)
    assert cut.startswith("A" * 10), cut[:20]
    assert cut.endswith("A" * 10), cut[-20:]
    assert "中间省略 500 字符" in cut, cut[:200]

    # --- 失败提示：按 DSH 自己的话匹配，而不是退出码 -----------------------
    assert "凭证缺失" in _failure_hint("", "MISSING_CREDENTIAL x")
    assert "凭证缺失" in _failure_hint("MISSING_CREDENTIAL", "")
    assert "会话 id" in _failure_hint("", 'session "x" does not exist')
    assert "工作目录" in _failure_hint("", 'session "x" was recorded in "A", not "B"')
    assert "insert:" in _failure_hint("", "patch not found")
    assert _failure_hint("一切正常", "一切正常") == ""

    # --- 版本：能读到就读，读不到返回 None（不能抛）------------------------
    version = _dsh_version()
    assert version is None or isinstance(version, str), version
    assert _dsh_version() is version, "版本必须缓存，别每次去读文件"
    suffix = _version_suffix()
    assert suffix == (f"，dsh={version}" if version else ""), suffix

    # --- 渲染器把版本写进头一行 -------------------------------------------
    from dsh_events import render_events
    rendered = render_events('{"type":"session","sessionId":"session-1"}\n{"type":"final","text":"ok"}')
    head = rendered.summary("dsh-agent", 0, 4000, "9.9.9").splitlines()[0]
    assert "dsh=9.9.9" in head, head
    plain = rendered.summary("dsh-agent", 0, 4000).splitlines()[0]
    assert "dsh=" not in plain, plain

    # --- 环境自述（不联网、不判定成败，只报告看到什么）--------------------
    _log(
        f"selftest OK — dsh_root={DSH_ROOT} node={_find_node()} "
        f"dsh={_dsh_version() or '未知'} profiles={len(_list_profiles())} "
        f"max_timeout={MAX_TIMEOUT}s max_output={MAX_OUTPUT_CHARS}"
    )
    return 0


def main() -> int:
    """Start the server, or run the offline self-test."""
    if mcp is None:
        sys.stderr.write(f"{_MCP_IMPORT_ERROR}\n")
        return 2
    _log(f"启动：dsh_root={DSH_ROOT} default_profile={DEFAULT_PROFILE} workspace={DEFAULT_WORKSPACE}")
    mcp.run()
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    raise SystemExit(main())
