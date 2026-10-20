"""dsh_events.py — 把 `dsh --json` 的事件流渲染成人话。

单独一个模块，**只用标准库**：渲染逻辑是这套桥里最容易被改坏、也最值得单独测的一块，
拆出来之后 `verify/` 里就能用任意 python 直接验证它，不需要装 mcp 包、也不需要起服务端。

事件流是逐行 JSON，形状来自 `dsh-headless` 的 json-stream（本机 0.2.0-rc.2 实测）：

    {"type":"session","sessionId":"session-<uuid>","cwd":"C:\work"}
    {"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end","turn":N,...}
    {"type":"thinking","text":"..."}
    {"type":"text","text":"..."}
    {"type":"tool_call","callId":"...","tool":"read_file","input":{...}}
    {"type":"tool_result","callId":"...","status":"completed"|"error","result":"..."}
    {"type":"final","text":"..."}

其中 `sessionId` 是**唯一**能拿到会话 id 的地方：`--session-id` 只能续、不能新建
（传一个不存在的 id 会 `does not exist` 直接失败），stdout 的纯文本模式里也没有它。
拿到它，Hermes 才能在「发任务 → 审核 → 再发任务」里接上同一条会话。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field


@dataclass
class RenderedRun:
    """一次 DSH 运行的事件流渲染结果。"""

    #: `session-<uuid>`，拿不到时为 None。
    session_id: str | None = None
    #: 工作目录，事件流自己报的那个。
    cwd: str | None = None
    #: 最终回答：优先取 `final` 事件，没有就拼接全部 `text` 事件。
    answer: str = ""
    #: 过程轨迹，按顺序的 `[tool] xxx` / `[result] yyy` 行。
    trace: list[str] = field(default_factory=list)
    #: 推理块的数量（不展开内容，只给个量）。
    thinking_blocks: int = 0
    #: 是否真的解析到了事件。为 False 时 stdout 不是事件流，调用方应退回纯文本。
    parsed: bool = False
    #: 是否见到了 `final`；没有的话 `answer` 是拼接出来的，可信度低一档。
    finished: bool = False

    def summary(self, profile: str, exit_code: int, limit: int, dsh_version: "str | None" = None) -> str:
        """渲染成给模型看的报告。

        `会话 id` 放在最前面且措辞固定：它会成为下一轮 `dsh_resume` 的入参，
        也是审核之后接着干活的唯一把手。

        `dsh_version` 也写进头一行。事件流是 DSH 的内部格式，没有版本承诺；
        升级后最坏的情况不是崩，而是总结悄悄少了内容 —— 把版本摆在这里，
        那种变化就是看得见的。
        """
        lines: list[str] = []
        header = f"DSH 完成（退出码 {exit_code}，profile={profile}"
        if dsh_version:
            header += f"，dsh={dsh_version}"
        if self.cwd:
            header += f"，cwd={self.cwd}"
        lines.append(header + "）")
        if self.session_id:
            lines.append(f"会话 id: {self.session_id}")
        else:
            lines.append("会话 id: （这次没拿到，无法续会话）")
        lines.append("")
        lines.append(self.answer if self.answer.strip() else "（没有文本输出）")

        if self.trace:
            lines.append("")
            lines.append(f"--- 过程（{len(self.trace)} 步）---")
            lines.extend(self.trace)
        if self.thinking_blocks:
            lines.append("")
            lines.append(f"（另有 {self.thinking_blocks} 段推理，已省略）")
        if not self.finished and self.parsed:
            lines.append("")
            lines.append("注意：事件流里没有 final 事件，上面的回答是从 text 事件拼出来的。")

        text = "\n".join(lines)
        if len(text) <= limit:
            return text
        head = text[: limit // 2]
        tail = text[-(limit // 2):]
        return f"{head}\n\n... [中间省略 {len(text) - limit} 字符] ...\n\n{tail}"


def render_events(raw: str) -> RenderedRun:
    """把 `dsh --json` 的原始输出渲染成一次运行的结果。

    逐行解析，坏行跳过而不是抛异常：stdout 里可能混进与协议无关的输出（依赖的
    警告、被 profile 顺带打印的东西），一行都解析不了才判定「不是事件流」。
    """
    result = RenderedRun()
    texts: list[str] = []
    have_session = False

    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if not isinstance(kind, str):
            continue
        result.parsed = True

        if kind == "session":
            have_session = True
            session_id = event.get("sessionId")
            if isinstance(session_id, str) and session_id:
                result.session_id = session_id
            cwd = event.get("cwd")
            if isinstance(cwd, str) and cwd:
                result.cwd = cwd
        elif kind == "text":
            text = event.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
        elif kind == "thinking":
            result.thinking_blocks += 1
        elif kind == "tool_call":
            tool = event.get("tool")
            result.trace.append(f"[tool] {tool if isinstance(tool, str) else '?'}")
        elif kind == "tool_result":
            status = event.get("status")
            result.trace.append(f"[result] {status if isinstance(status, str) else '?'}")
        elif kind == "final":
            text = event.get("text")
            result.finished = True
            result.answer = text if isinstance(text, str) else ""

    if not result.finished:
        result.answer = "\n\n".join(texts)
    if not have_session:
        result.session_id = None
    return result


def _selftest() -> int:
    """离线自检：用固定事件流验证渲染，退出码 0 表示通过。

    `verify/bridge-render.mjs` 就是跑这个。它不需要 mcp 包、不联网、不起服务端。
    """
    fixture = "\n".join([
        '{"type":"session","sessionId":"session-11111111-2222-3333-4444-555555555555","cwd":"C:\\\\work"}',
        '{"type":"status","phase":"turn_start","turn":1}',
        '{"type":"thinking","text":"想想"}',
        '{"type":"tool_call","callId":"c1","tool":"read_file","input":{}}',
        '{"type":"tool_result","callId":"c1","status":"completed","result":"ok"}',
        '{"type":"text","text":"先读文件"}',
        '{"type":"final","text":"做完了"}',
    ])
    rendered = render_events(fixture)
    assert rendered.session_id == "session-11111111-2222-3333-4444-555555555555", rendered.session_id
    assert rendered.cwd == "C:\\work", rendered.cwd
    assert rendered.answer == "做完了", rendered.answer
    assert rendered.trace == ["[tool] read_file", "[result] completed"], rendered.trace
    assert rendered.thinking_blocks == 1, rendered.thinking_blocks
    assert rendered.parsed and rendered.finished

    # 纯文本 stdout（没有事件）必须判成未解析，而不是假装解析出了一个空回答。
    plain = render_events("OK\n一些警告\n")
    assert plain.parsed is False, plain
    assert plain.answer == "", plain.answer
    assert plain.session_id is None

    # 没有 final 时退回拼接 text，并标记 finished=False。
    partial = render_events('{"type":"session","sessionId":"session-x"}\n{"type":"text","text":"一半"}')
    assert partial.answer == "一半", partial.answer
    assert partial.finished is False
    assert partial.session_id == "session-x"

    # 混进坏行不能炸。
    noisy = render_events('not json\n{"type":"final","text":"ok"}\n{ broken')
    assert noisy.answer == "ok" and noisy.parsed

    print("selftest OK")
    return 0


if __name__ == "__main__":
    import sys

    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    raise SystemExit("usage: python dsh_events.py --selftest")
