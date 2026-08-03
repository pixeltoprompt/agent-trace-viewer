# Agent Trace Viewer

**[Live demo →](https://agent-trace-viewer.vercel.app/)**

![Agent Trace Viewer](

https://github.com/user-attachments/assets/89417a41-36ff-4387-a985-78fd67985302

)

A visual debugger for LangGraph runs. Load a trace, see the graph that executed, the
timeline it executed on, and the state at every step.

    npm install
    npm run dev

Three sample traces are bundled (`src/traces/`), so the app works with no setup and no
API key. To view your own runs, add `trace_dumper.py` to your LangGraph project:

```python
from trace_dumper import LangGraphTracer

tracer = LangGraphTracer(name="my_agent").attach_graph(graph)
graph.invoke(state, config={"callbacks": [tracer]})
tracer.dump("traces/run.json")
```

Then drop the JSON onto the window, or copy it into `src/traces/` to bundle it with the
build. Format is documented in `SCHEMA.md`.

## What it shows

**Graph** — the compiled topology, with the executed path lit and unreached nodes dimmed.
A node that ran more than once renders as stacked plates, one per attempt.

**Timeline** — one lane per step on a shared time axis. The ribbons beneath each bar are
the model and tool calls inside that step. The `graph overhead` row is every slice of the
axis no node was running: routing, checkpoint writes, state merges.

**Inspector** — state, output, tool calls and token spend for the selected step.

Selection is shared: clicking a node highlights its lane, and clicking a lane highlights
its node.
