"""
trace_dumper.py — emit Agent Trace Format v1.0 JSON from a LangGraph run.

Usage
-----
    from trace_dumper import LangGraphTracer

    tracer = LangGraphTracer(name="rewards_agent")
    tracer.attach_graph(graph)                      # compiled graph -> topology

    result = graph.invoke(state, config={"callbacks": [tracer]})
    tracer.dump("traces/clean_run.json")

Or, to capture failures too:

    from trace_dumper import trace_run

    result = trace_run(graph, state, name="rewards_agent",
                       out_path="traces/failure_run.json", raise_on_error=False)

Requires: langchain-core, langgraph (both already present in a LangGraph project).
"""

from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import asdict, is_dataclass
from typing import Any, Dict, List, Optional
from uuid import UUID

from langchain_core.callbacks.base import BaseCallbackHandler

TRACE_VERSION = "1.0"

# USD per 1M tokens. Substring match on the model name, longest match wins.
# Update to whatever you actually run; unknown models simply cost 0.
DEFAULT_PRICES: Dict[str, Dict[str, float]] = {
    "claude-opus-4":    {"in": 15.00, "out": 75.00},
    "claude-sonnet-4":  {"in": 3.00,  "out": 15.00},
    "claude-haiku-4":   {"in": 1.00,  "out": 5.00},
    "gpt-4o-mini":      {"in": 0.15,  "out": 0.60},
    "gpt-4o":           {"in": 2.50,  "out": 10.00},
    "gemini-2.0-flash": {"in": 0.10,  "out": 0.40},
}


def _now_ms() -> int:
    return int(time.time() * 1000)


# --------------------------------------------------------------------------- #
# JSON-safe serialisation
# --------------------------------------------------------------------------- #

def _safe(obj: Any, depth: int = 0, max_string: int = 4000) -> Any:
    """Recursively convert arbitrary objects into JSON-serialisable structures."""
    if depth > 8:
        return "<max depth>"
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    if isinstance(obj, str):
        if len(obj) <= max_string:
            return obj
        return obj[:max_string] + f"… <truncated {len(obj) - max_string} chars>"
    if isinstance(obj, (UUID,)):
        return str(obj)
    if isinstance(obj, dict):
        return {str(k): _safe(v, depth + 1, max_string) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        items = list(obj)
        out = [_safe(v, depth + 1, max_string) for v in items[:200]]
        if len(items) > 200:
            out.append(f"… <{len(items) - 200} more items>")
        return out

    # LangChain messages -> compact dict the viewer can render directly
    if hasattr(obj, "content") and hasattr(obj, "type"):
        msg: Dict[str, Any] = {
            "role": getattr(obj, "type", None),
            "content": _safe(getattr(obj, "content", None), depth + 1, max_string),
        }
        for attr in ("name", "tool_call_id"):
            val = getattr(obj, attr, None)
            if val:
                msg[attr] = val
        tool_calls = getattr(obj, "tool_calls", None)
        if tool_calls:
            msg["tool_calls"] = _safe(tool_calls, depth + 1, max_string)
        return msg

    if is_dataclass(obj) and not isinstance(obj, type):
        try:
            return _safe(asdict(obj), depth + 1, max_string)
        except Exception:
            pass
    for method in ("model_dump", "dict"):
        fn = getattr(obj, method, None)
        if callable(fn):
            try:
                return _safe(fn(), depth + 1, max_string)
            except Exception:
                pass
    return _safe(repr(obj), depth + 1, max_string)


def _err(exc: BaseException) -> Dict[str, str]:
    return {"type": type(exc).__name__, "message": str(exc)[:2000]}


def _price(model: Optional[str], prices: Dict[str, Dict[str, float]]) -> Dict[str, float]:
    if not model:
        return {"in": 0.0, "out": 0.0}
    name = model.lower()
    best, best_len = {"in": 0.0, "out": 0.0}, -1
    for key, rate in prices.items():
        if key in name and len(key) > best_len:
            best, best_len = rate, len(key)
    return best


# --------------------------------------------------------------------------- #
# Tracer
# --------------------------------------------------------------------------- #

class LangGraphTracer(BaseCallbackHandler):
    """Callback handler that records a LangGraph run as an Agent Trace v1.0 document.

    Node-level steps are detected via the ``langgraph_node`` metadata key. Runnables
    nested inside a node inherit that metadata, so any run whose ancestor is already a
    registered node run is skipped — this is what keeps the timeline at node
    granularity instead of exploding into every prompt template and parser.
    """

    raise_error = False  # never let tracing break the agent

    def __init__(
        self,
        name: str = "agent",
        prices: Optional[Dict[str, Dict[str, float]]] = None,
        max_string: int = 4000,
    ) -> None:
        self.name = name
        self.prices = prices or DEFAULT_PRICES
        self.max_string = max_string
        self.reset()

    def reset(self) -> None:
        self.run_id = str(uuid.uuid4())
        self.ts_start: Optional[int] = None
        self.ts_end: Optional[int] = None
        self.status = "success"
        self.error: Optional[Dict[str, str]] = None
        self.input: Any = None
        self.output: Any = None

        self.nodes: List[Dict[str, Any]] = []
        self.edges: List[Dict[str, Any]] = []
        self.steps: List[Dict[str, Any]] = []

        self._parents: Dict[UUID, Optional[UUID]] = {}
        self._step_of_run: Dict[UUID, Dict[str, Any]] = {}
        self._attempts: Dict[str, int] = {}
        self._root_run: Optional[UUID] = None
        self._open_tools: Dict[UUID, Dict[str, Any]] = {}
        self._open_llms: Dict[UUID, Dict[str, Any]] = {}
        self._counter = 0

    # -- graph topology ----------------------------------------------------- #

    def attach_graph(self, compiled_graph: Any) -> "LangGraphTracer":
        """Read nodes and edges off a compiled LangGraph. Safe to skip."""
        try:
            g = compiled_graph.get_graph()
        except Exception:
            return self

        nodes = getattr(g, "nodes", {}) or {}
        for node_id, node in (nodes.items() if isinstance(nodes, dict) else []):
            label = getattr(node, "name", None) or str(node_id)
            if node_id == "__start__":
                node_type = "start"
            elif node_id == "__end__":
                node_type = "end"
            else:
                node_type = "node"
            self.nodes.append({"id": str(node_id), "label": str(label), "type": node_type})

        for edge in (getattr(g, "edges", []) or []):
            self.edges.append({
                "from": str(getattr(edge, "source", "")),
                "to": str(getattr(edge, "target", "")),
                "conditional": bool(getattr(edge, "conditional", False)),
                "label": getattr(edge, "data", None),
            })
        return self

    # -- internals ---------------------------------------------------------- #

    def _uid(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}{self._counter}"

    def _ancestor_step(self, run_id: Optional[UUID]) -> Optional[Dict[str, Any]]:
        seen = set()
        cur = run_id
        while cur is not None and cur not in seen:
            seen.add(cur)
            if cur in self._step_of_run:
                return self._step_of_run[cur]
            cur = self._parents.get(cur)
        return None

    # -- chain (node) callbacks --------------------------------------------- #

    def on_chain_start(
        self,
        serialized: Optional[Dict[str, Any]],
        inputs: Any,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        self._parents[run_id] = parent_run_id

        if self._root_run is None and parent_run_id is None:
            self._root_run = run_id
            self.ts_start = _now_ms()
            self.input = _safe(inputs, max_string=self.max_string)

        md = metadata or {}
        node_id = md.get("langgraph_node")
        if not node_id:
            return
        if self._ancestor_step(parent_run_id) is not None:
            return  # nested runnable inside a node we're already tracking

        self._attempts[node_id] = self._attempts.get(node_id, 0) + 1
        step = {
            "step_id": self._uid("s"),
            "node_id": str(node_id),
            "step_index": len(self.steps),
            "attempt": self._attempts[node_id],
            "ts_start": _now_ms(),
            "ts_end": None,
            "duration_ms": None,
            "status": "success",
            "error": None,
            "state_before": _safe(inputs, max_string=self.max_string),
            "state_after": None,
            "output": None,
            "tokens_in": 0,
            "tokens_out": 0,
            "cost_usd": 0.0,
            "tool_calls": [],
            "llm_calls": [],
        }
        self.steps.append(step)
        self._step_of_run[run_id] = step

    def on_chain_end(self, outputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        step = self._step_of_run.pop(run_id, None)
        if step is not None:
            step["ts_end"] = _now_ms()
            step["duration_ms"] = step["ts_end"] - step["ts_start"]
            step["output"] = _safe(outputs, max_string=self.max_string)
            before = step["state_before"]
            after = step["output"]
            step["state_after"] = (
                {**before, **after} if isinstance(before, dict) and isinstance(after, dict) else after
            )
        if run_id == self._root_run:
            self.ts_end = _now_ms()
            self.output = _safe(outputs, max_string=self.max_string)

    def on_chain_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        step = self._step_of_run.pop(run_id, None)
        if step is not None:
            step["ts_end"] = _now_ms()
            step["duration_ms"] = step["ts_end"] - step["ts_start"]
            step["status"] = "error"
            step["error"] = _err(error)
            step["state_after"] = step["state_before"]
        if run_id == self._root_run:
            self.ts_end = _now_ms()
            self.status = "error"
            self.error = _err(error)

    # -- tool callbacks ------------------------------------------------------ #

    def on_tool_start(
        self,
        serialized: Optional[Dict[str, Any]],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        inputs: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        self._parents[run_id] = parent_run_id
        name = (serialized or {}).get("name") or kwargs.get("name") or "tool"
        self._open_tools[run_id] = {
            "id": self._uid("t"),
            "name": str(name),
            "input": _safe(inputs if inputs is not None else input_str, max_string=self.max_string),
            "output": None,
            "ts_start": _now_ms(),
            "ts_end": None,
            "duration_ms": None,
            "status": "success",
            "error": None,
        }

    def _close_tool(self, run_id: UUID, output: Any, error: Optional[BaseException]) -> None:
        rec = self._open_tools.pop(run_id, None)
        if rec is None:
            return
        rec["ts_end"] = _now_ms()
        rec["duration_ms"] = rec["ts_end"] - rec["ts_start"]
        if error is not None:
            rec["status"] = "error"
            rec["error"] = _err(error)
        else:
            rec["output"] = _safe(output, max_string=self.max_string)
        step = self._ancestor_step(self._parents.get(run_id))
        if step is not None:
            step["tool_calls"].append(rec)

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._close_tool(run_id, output, None)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._close_tool(run_id, None, error)

    # -- LLM callbacks ------------------------------------------------------- #

    def _llm_start(self, serialized, run_id, parent_run_id, kwargs) -> None:
        self._parents[run_id] = parent_run_id
        params = (kwargs.get("invocation_params") or {})
        model = params.get("model") or params.get("model_name") or (serialized or {}).get("name")
        self._open_llms[run_id] = {
            "id": self._uid("l"),
            "model": str(model) if model else None,
            "ts_start": _now_ms(),
            "ts_end": None,
            "duration_ms": None,
            "tokens_in": 0,
            "tokens_out": 0,
            "cost_usd": 0.0,
            "status": "success",
            "error": None,
        }

    def on_llm_start(self, serialized, prompts, *, run_id: UUID,
                     parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        self._llm_start(serialized, run_id, parent_run_id, kwargs)

    def on_chat_model_start(self, serialized, messages, *, run_id: UUID,
                            parent_run_id: Optional[UUID] = None, **kwargs: Any) -> None:
        self._llm_start(serialized, run_id, parent_run_id, kwargs)

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        rec = self._open_llms.pop(run_id, None)
        if rec is None:
            return
        rec["ts_end"] = _now_ms()
        rec["duration_ms"] = rec["ts_end"] - rec["ts_start"]

        usage: Dict[str, Any] = {}
        llm_output = getattr(response, "llm_output", None) or {}
        if isinstance(llm_output, dict):
            usage = llm_output.get("token_usage") or llm_output.get("usage") or {}
            rec["model"] = llm_output.get("model_name") or llm_output.get("model") or rec["model"]
        if not usage:
            try:
                msg = response.generations[0][0].message
                usage = getattr(msg, "usage_metadata", None) or {}
                meta = getattr(msg, "response_metadata", None) or {}
                rec["model"] = meta.get("model") or meta.get("model_name") or rec["model"]
            except Exception:
                usage = {}

        def pick(*keys: str) -> int:
            for k in keys:
                v = usage.get(k) if isinstance(usage, dict) else None
                if isinstance(v, (int, float)):
                    return int(v)
            return 0

        rec["tokens_in"] = pick("input_tokens", "prompt_tokens")
        rec["tokens_out"] = pick("output_tokens", "completion_tokens")
        rate = _price(rec["model"], self.prices)
        rec["cost_usd"] = round(
            rec["tokens_in"] / 1e6 * rate["in"] + rec["tokens_out"] / 1e6 * rate["out"], 6
        )

        step = self._ancestor_step(self._parents.get(run_id))
        if step is not None:
            step["llm_calls"].append(rec)
            step["tokens_in"] += rec["tokens_in"]
            step["tokens_out"] += rec["tokens_out"]
            step["cost_usd"] = round(step["cost_usd"] + rec["cost_usd"], 6)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        rec = self._open_llms.pop(run_id, None)
        if rec is None:
            return
        rec["ts_end"] = _now_ms()
        rec["duration_ms"] = rec["ts_end"] - rec["ts_start"]
        rec["status"] = "error"
        rec["error"] = _err(error)
        step = self._ancestor_step(self._parents.get(run_id))
        if step is not None:
            step["llm_calls"].append(rec)

    # -- output -------------------------------------------------------------- #

    def to_dict(self) -> Dict[str, Any]:
        ts_start = self.ts_start or (self.steps[0]["ts_start"] if self.steps else _now_ms())
        ts_end = self.ts_end or _now_ms()

        # close anything left dangling (hard crash mid-node)
        for step in self.steps:
            if step["ts_end"] is None:
                step["ts_end"] = ts_end
                step["duration_ms"] = step["ts_end"] - step["ts_start"]
                if step["status"] == "success":
                    step["status"] = "error"
                    step["error"] = step["error"] or {
                        "type": "Incomplete", "message": "Step never completed."
                    }

        steps = sorted(self.steps, key=lambda s: s["ts_start"])
        for i, step in enumerate(steps):
            step["step_index"] = i

        # topology fallback: infer nodes from what actually executed
        nodes = self.nodes
        if not nodes:
            seen: List[str] = []
            for step in steps:
                if step["node_id"] not in seen:
                    seen.append(step["node_id"])
            nodes = [{"id": n, "label": n, "type": "node"} for n in seen]

        return {
            "trace_version": TRACE_VERSION,
            "run_id": self.run_id,
            "name": self.name,
            "ts_start": ts_start,
            "ts_end": ts_end,
            "duration_ms": ts_end - ts_start,
            "status": self.status,
            "error": self.error,
            "input": self.input,
            "output": self.output,
            "totals": {
                "steps": len(steps),
                "failed_steps": sum(1 for s in steps if s["status"] == "error"),
                "retries": sum(1 for s in steps if s["attempt"] > 1),
                "tool_calls": sum(len(s["tool_calls"]) for s in steps),
                "llm_calls": sum(len(s["llm_calls"]) for s in steps),
                "tokens_in": sum(s["tokens_in"] for s in steps),
                "tokens_out": sum(s["tokens_out"] for s in steps),
                "cost_usd": round(sum(s["cost_usd"] for s in steps), 6),
            },
            "nodes": nodes,
            "edges": self.edges,
            "steps": steps,
        }

    def dump(self, path: str) -> str:
        directory = os.path.dirname(os.path.abspath(path))
        os.makedirs(directory, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.to_dict(), fh, indent=2, ensure_ascii=False, default=str)
        return path


# --------------------------------------------------------------------------- #
# Convenience wrapper
# --------------------------------------------------------------------------- #

def trace_run(
    graph: Any,
    state: Any,
    name: str = "agent",
    out_path: str = "traces/run.json",
    config: Optional[Dict[str, Any]] = None,
    raise_on_error: bool = True,
    **invoke_kwargs: Any,
) -> Any:
    """Invoke a compiled graph and write a trace, whether it succeeds or blows up."""
    tracer = LangGraphTracer(name=name).attach_graph(graph)
    cfg = dict(config or {})
    cfg["callbacks"] = list(cfg.get("callbacks", [])) + [tracer]
    try:
        result = graph.invoke(state, config=cfg, **invoke_kwargs)
        return result
    except Exception as exc:  # noqa: BLE001 — we want the failure trace
        if tracer.status != "error":
            tracer.status = "error"
            tracer.error = _err(exc)
        if raise_on_error:
            raise
        return None
    finally:
        tracer.dump(out_path)
        print(f"[trace] wrote {out_path}")
