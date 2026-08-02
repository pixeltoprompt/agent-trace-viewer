# Agent Trace Format v1.0

A single JSON file describing one execution of a LangGraph agent.
Produced by `trace_dumper.py`, consumed by the Agent Trace Viewer.

Design rules:

- **One file = one run.** No streaming, no partials. Simplifies the viewer enormously.
- **Timestamps are epoch milliseconds (integers).** The waterfall is then
  `left = ts_start - trace.ts_start`, `width = duration_ms`. No date parsing in React.
- **No `state_diff` field.** The viewer computes the diff from `state_before` /
  `state_after`. Keeps payloads small and keeps the diff logic on the UI side.
- **Everything is JSON-safe.** LangChain messages, Pydantic models and dataclasses are
  flattened by the dumper. Long strings are truncated with a visible marker.

---

## Top level

```jsonc
{
  "trace_version": "1.0",
  "run_id": "9f1c...",            // uuid
  "name": "rewards_agent",        // graph / app name
  "ts_start": 1754130000000,      // epoch ms
  "ts_end": 1754130004120,
  "duration_ms": 4120,
  "status": "success",            // "success" | "error"
  "error": null,                  // or { "type": "ValueError", "message": "..." }
  "input": {},                    // initial state passed to invoke()
  "output": {},                   // final state (null if the run errored)
  "totals": {
    "steps": 6,
    "failed_steps": 0,
    "retries": 0,
    "tool_calls": 3,
    "llm_calls": 4,
    "tokens_in": 8120,
    "tokens_out": 940,
    "cost_usd": 0.0412
  },
  "nodes": [],                    // graph topology, see below
  "edges": [],
  "steps": []                     // execution timeline, see below
}
```

## `nodes[]` — static topology

```jsonc
{
  "id": "fetch_rewards",
  "label": "fetch_rewards",
  "type": "node"                  // "start" | "node" | "end"
}
```

`__start__` and `__end__` are included so the graph renders with entry/exit points.

## `edges[]` — static topology

```jsonc
{
  "from": "classify",
  "to": "fetch_rewards",
  "conditional": true,            // dashed line in the viewer
  "label": "needs_lookup"         // branch condition name, or null
}
```

## `steps[]` — one entry per node execution

Ordered by `ts_start`. A node that runs twice (loop or retry) appears twice with
different `attempt` values — that's what drives the retry highlighting.

```jsonc
{
  "step_id": "s3",
  "node_id": "fetch_rewards",
  "step_index": 3,                // execution order, 0-based
  "attempt": 2,                   // 1 on first execution of this node
  "ts_start": 1754130001200,
  "ts_end": 1754130002050,
  "duration_ms": 850,
  "status": "success",            // "success" | "error"
  "error": null,                  // or { "type": "...", "message": "..." }

  "state_before": {},             // node's input state
  "state_after": {},              // state_before merged with the node's returned update
  "output": {},                   // just the update the node returned

  "tokens_in": 1820,
  "tokens_out": 240,
  "cost_usd": 0.0091,

  "tool_calls": [
    {
      "id": "t1",
      "name": "search_rewards_db",
      "input": {},
      "output": "…",
      "ts_start": 1754130001300,
      "ts_end": 1754130001900,
      "duration_ms": 600,
      "status": "success",
      "error": null
    }
  ],

  "llm_calls": [
    {
      "id": "l1",
      "model": "claude-sonnet-4-5",
      "ts_start": 1754130001950,
      "ts_end": 1754130002040,
      "duration_ms": 90,
      "tokens_in": 1820,
      "tokens_out": 240,
      "cost_usd": 0.0091,
      "status": "success",
      "error": null
    }
  ]
}
```

### Caveat on `state_after`

LangGraph applies channel reducers (e.g. `add_messages`) when merging a node's return
value into global state. The dumper cannot see post-reducer state from inside a callback,
so `state_after` is computed as `{**state_before, **output}` — the node's own view of its
effect. For non-reducer channels this is exact; for reducer channels (message lists) the
returned update is shown rather than the appended result. `output` is always the raw,
unmodified return value, so nothing is lost.

## Status values

Only `success` and `error`. No `running` / `pending` — the file is written after the run
completes. The viewer needs exactly two colours.
