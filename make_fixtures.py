"""
make_fixtures.py — generate three Agent Trace v1.0 fixtures with no dependencies.

    python make_fixtures.py            # writes to ./traces
    python make_fixtures.py out_dir    # writes elsewhere

Produces:
    traces/clean_run.json    happy path, 5 nodes
    traces/retry_run.json    one node fails then succeeds on attempt 2
    traces/failure_run.json  run dies mid-graph, downstream nodes never execute

Build the whole viewer against these, then swap in real traces from trace_dumper.py.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from typing import Any, Dict, List

T0 = 1754130000000  # fixed epoch ms so fixtures are byte-stable

NODES = [
    {"id": "__start__", "label": "__start__", "type": "start"},
    {"id": "classify", "label": "classify", "type": "node"},
    {"id": "fetch_rewards", "label": "fetch_rewards", "type": "node"},
    {"id": "rank_offers", "label": "rank_offers", "type": "node"},
    {"id": "compose_reply", "label": "compose_reply", "type": "node"},
    {"id": "__end__", "label": "__end__", "type": "end"},
]

EDGES = [
    {"from": "__start__", "to": "classify", "conditional": False, "label": None},
    {"from": "classify", "to": "fetch_rewards", "conditional": True, "label": "needs_lookup"},
    {"from": "classify", "to": "compose_reply", "conditional": True, "label": "direct_answer"},
    {"from": "fetch_rewards", "to": "rank_offers", "conditional": False, "label": None},
    {"from": "rank_offers", "to": "compose_reply", "conditional": False, "label": None},
    {"from": "compose_reply", "to": "__end__", "conditional": False, "label": None},
]

QUERY = "Which of my cards gives the best cashback on groceries?"


def step(
    idx: int,
    node_id: str,
    start_offset: int,
    duration: int,
    state_before: Dict[str, Any],
    output: Dict[str, Any],
    attempt: int = 1,
    status: str = "success",
    error: Dict[str, str] | None = None,
    tool_calls: List[Dict[str, Any]] | None = None,
    llm_calls: List[Dict[str, Any]] | None = None,
) -> Dict[str, Any]:
    tool_calls = tool_calls or []
    llm_calls = llm_calls or []
    return {
        "step_id": f"s{idx + 1}",
        "node_id": node_id,
        "step_index": idx,
        "attempt": attempt,
        "ts_start": T0 + start_offset,
        "ts_end": T0 + start_offset + duration,
        "duration_ms": duration,
        "status": status,
        "error": error,
        "state_before": state_before,
        "state_after": ({**state_before, **output} if status == "success" else state_before),
        "output": output if status == "success" else None,
        "tokens_in": sum(c["tokens_in"] for c in llm_calls),
        "tokens_out": sum(c["tokens_out"] for c in llm_calls),
        "cost_usd": round(sum(c["cost_usd"] for c in llm_calls), 6),
        "tool_calls": tool_calls,
        "llm_calls": llm_calls,
    }


def llm(cid: str, offset: int, duration: int, tin: int, tout: int) -> Dict[str, Any]:
    cost = round(tin / 1e6 * 3.0 + tout / 1e6 * 15.0, 6)
    return {
        "id": cid,
        "model": "claude-sonnet-4-5",
        "ts_start": T0 + offset,
        "ts_end": T0 + offset + duration,
        "duration_ms": duration,
        "tokens_in": tin,
        "tokens_out": tout,
        "cost_usd": cost,
        "status": "success",
        "error": None,
    }


def tool(
    tid: str, name: str, offset: int, duration: int,
    tool_input: Dict[str, Any], output: Any,
    status: str = "success", error: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    return {
        "id": tid,
        "name": name,
        "input": tool_input,
        "output": output if status == "success" else None,
        "ts_start": T0 + offset,
        "ts_end": T0 + offset + duration,
        "duration_ms": duration,
        "status": status,
        "error": error,
    }


def wrap(name: str, steps: List[Dict[str, Any]], status: str,
         final_output: Dict[str, Any] | None, error: Dict[str, str] | None) -> Dict[str, Any]:
    ts_start = min(s["ts_start"] for s in steps)
    ts_end = max(s["ts_end"] for s in steps) + 40
    return {
        "trace_version": "1.0",
        "run_id": str(uuid.uuid4()),
        "name": name,
        "ts_start": ts_start,
        "ts_end": ts_end,
        "duration_ms": ts_end - ts_start,
        "status": status,
        "error": error,
        "input": {"query": QUERY, "user_id": "u_8812"},
        "output": final_output,
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
        "nodes": NODES,
        "edges": EDGES,
        "steps": steps,
    }


BASE = {"query": QUERY, "user_id": "u_8812"}
CARDS = [
    {"card": "Axis Ace", "grocery_rate": 0.02},
    {"card": "HDFC Millennia", "grocery_rate": 0.05},
    {"card": "SBI Cashback", "grocery_rate": 0.05},
]
RANKED = [
    {"card": "SBI Cashback", "effective": 0.05, "cap_left": 4200},
    {"card": "HDFC Millennia", "effective": 0.05, "cap_left": 800},
    {"card": "Axis Ace", "effective": 0.02, "cap_left": 10000},
]
REPLY = "SBI Cashback is your best option for groceries at 5%, with ₹4,200 of cap left this cycle."


def clean_run() -> Dict[str, Any]:
    s1_state = dict(BASE)
    s1_out = {"intent": "card_recommendation", "needs_lookup": True}
    s2_state = {**s1_state, **s1_out}
    s2_out = {"cards": CARDS}
    s3_state = {**s2_state, **s2_out}
    s3_out = {"ranked": RANKED}
    s4_state = {**s3_state, **s3_out}
    s4_out = {"reply": REPLY}

    steps = [
        step(0, "classify", 0, 620, s1_state, s1_out,
             llm_calls=[llm("l1", 20, 580, 940, 45)]),
        step(1, "fetch_rewards", 640, 880, s2_state, s2_out,
             tool_calls=[tool("t1", "rewards_db.lookup", 660, 520,
                              {"user_id": "u_8812"}, {"rows": 3})]),
        step(2, "rank_offers", 1540, 340, s3_state, s3_out,
             tool_calls=[tool("t2", "cap_checker", 1560, 180,
                              {"cards": 3}, {"caps_resolved": 3})]),
        step(3, "compose_reply", 1900, 1180, s4_state, s4_out,
             llm_calls=[llm("l2", 1920, 1140, 2180, 190)]),
    ]
    return wrap("rewards_agent", steps, "success", {**s4_state, **s4_out}, None)


def retry_run() -> Dict[str, Any]:
    s1_state = dict(BASE)
    s1_out = {"intent": "card_recommendation", "needs_lookup": True}
    s2_state = {**s1_state, **s1_out}
    fetch_err = {"type": "TimeoutError", "message": "rewards_db.lookup timed out after 3000ms"}
    s3_out = {"cards": CARDS}
    s4_state = {**s2_state, **s3_out}
    s4_out = {"ranked": RANKED}
    s5_state = {**s4_state, **s4_out}
    s5_out = {"reply": REPLY}

    steps = [
        step(0, "classify", 0, 600, s1_state, s1_out,
             llm_calls=[llm("l1", 20, 560, 940, 45)]),
        step(1, "fetch_rewards", 620, 3020, s2_state, {}, attempt=1,
             status="error", error=fetch_err,
             tool_calls=[tool("t1", "rewards_db.lookup", 640, 3000,
                              {"user_id": "u_8812"}, None, status="error", error=fetch_err)]),
        step(2, "fetch_rewards", 3700, 760, s2_state, s3_out, attempt=2,
             tool_calls=[tool("t2", "rewards_db.lookup", 3720, 700,
                              {"user_id": "u_8812", "replica": "read-2"}, {"rows": 3})]),
        step(3, "rank_offers", 4480, 300, s4_state, s4_out),
        step(4, "compose_reply", 4800, 1240, s5_state, s5_out,
             llm_calls=[llm("l2", 4820, 1200, 2180, 190)]),
    ]
    return wrap("rewards_agent", steps, "success", {**s5_state, **s5_out}, None)


def failure_run() -> Dict[str, Any]:
    s1_state = dict(BASE)
    s1_out = {"intent": "card_recommendation", "needs_lookup": True}
    s2_state = {**s1_state, **s1_out}
    s2_out = {"cards": CARDS}
    s3_state = {**s2_state, **s2_out}
    rank_err = {
        "type": "KeyError",
        "message": "'cap_limit' missing on card 'HDFC Millennia' — schema drift in rewards_db",
    }

    steps = [
        step(0, "classify", 0, 610, s1_state, s1_out,
             llm_calls=[llm("l1", 20, 570, 940, 45)]),
        step(1, "fetch_rewards", 630, 840, s2_state, s2_out,
             tool_calls=[tool("t1", "rewards_db.lookup", 650, 780,
                              {"user_id": "u_8812"}, {"rows": 3})]),
        step(2, "rank_offers", 1490, 120, s3_state, {},
             status="error", error=rank_err,
             tool_calls=[tool("t2", "cap_checker", 1500, 90, {"cards": 3}, None,
                              status="error", error=rank_err)]),
    ]
    return wrap("rewards_agent", steps, "error", None, rank_err)


def main() -> None:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "traces"
    os.makedirs(out_dir, exist_ok=True)
    for filename, builder in (
        ("clean_run.json", clean_run),
        ("retry_run.json", retry_run),
        ("failure_run.json", failure_run),
    ):
        path = os.path.join(out_dir, filename)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(builder(), fh, indent=2, ensure_ascii=False)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
