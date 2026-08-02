// App.tsx — Drop into src/App.tsx
//
// Owns the only state that matters: which trace is loaded and which step is
// selected. Canvas and timeline are both projections of that single selection,
// which is why clicking a node in one highlights the lane in the other for free.

import { useCallback, useEffect, useMemo, useState } from "react";
import { GraphCanvas } from "./components/GraphCanvas";
import { Waterfall } from "./components/Waterfall";
import { Inspector } from "./components/Inspector";
import { fmtCost, fmtMs, fmtTokens, isTrace, type Step, type Trace } from "./lib/trace";
import "./styles/canvas.css";
import "./styles/waterfall.css";
import "./styles/app.css";

// Bundled fixtures. Anything dropped into src/traces/*.json ships with the build,
// so the deployed demo works with no upload and no API key.
const bundled = import.meta.glob<Trace>("./traces/*.json", { eager: true, import: "default" });

function loadBundled(): Trace[] {
  return Object.entries(bundled)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, trace]) => trace)
    .filter(isTrace);
}

export default function App() {
  const [traces, setTraces] = useState<Trace[]>(loadBundled);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const trace = traces[activeIndex];
  const selectedStep = useMemo(
    () => trace?.steps.find((s) => s.step_id === selectedStepId) ?? null,
    [trace, selectedStepId],
  );

  useEffect(() => setSelectedStepId(null), [activeIndex]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Canvas speaks node ids, the timeline speaks step ids. A node can run more than
  // once, so selecting a node means selecting its first attempt — the timeline is
  // where you pick between attempts.
  const selectNode = useCallback(
    (nodeId: string | null) => {
      if (!nodeId || !trace) return setSelectedStepId(null);
      const first = trace.steps.find((s) => s.node_id === nodeId);
      setSelectedStepId(first?.step_id ?? null);
    },
    [trace],
  );

  const selectStep = useCallback((step: Step | null) => {
    setSelectedStepId(step?.step_id ?? null);
  }, []);

  const ingest = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const accepted: Trace[] = [];
    const rejected: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const parsed = JSON.parse(await file.text());
        if (isTrace(parsed)) accepted.push(parsed);
        else rejected.push(file.name);
      } catch {
        rejected.push(file.name);
      }
    }

    if (accepted.length) {
      setTraces((prev) => {
        setActiveIndex(prev.length);
        return [...prev, ...accepted];
      });
    }
    if (rejected.length) {
      setNotice(`Not a trace file: ${rejected.join(", ")}. Expected JSON from trace_dumper.py.`);
    }
  }, []);

  if (!trace) {
    return (
      <div className="app app-empty">
        <p className="empty-title">No traces loaded</p>
        <p className="empty-body">
          Run <code>python make_fixtures.py src/traces</code> in the project root, or drop a trace
          JSON file onto this window.
        </p>
      </div>
    );
  }

  const t = trace.totals;

  return (
    <div
      className={`app ${dropping ? "is-dropping" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => { e.preventDefault(); setDropping(false); void ingest(e.dataTransfer.files); }}
    >
      <header className="bar">
        <div className="bar-id">
          <h1 className="bar-name">{trace.name}</h1>
          <span className={`pill ${trace.status === "error" ? "is-fault" : "is-ok"}`}>
            {trace.status === "error" ? "failed" : "completed"}
          </span>
          <span className="bar-run" title={trace.run_id}>{trace.run_id.slice(0, 8)}</span>
        </div>

        <dl className="rollup">
          <Metric label="wall clock" value={fmtMs(trace.duration_ms)} />
          <Metric label="steps" value={String(t.steps)} />
          <Metric label="retries" value={String(t.retries)} tone={t.retries ? "warn" : undefined} />
          <Metric label="faults" value={String(t.failed_steps)} tone={t.failed_steps ? "fault" : undefined} />
          <Metric label="tools" value={String(t.tool_calls)} />
          <Metric label="tokens" value={`${fmtTokens(t.tokens_in)}→${fmtTokens(t.tokens_out)}`} />
          <Metric label="cost" value={fmtCost(t.cost_usd)} />
        </dl>

        <div className="bar-source">
          <select
            className="picker"
            value={activeIndex}
            onChange={(e) => setActiveIndex(Number(e.target.value))}
            aria-label="Select trace"
          >
            {traces.map((item, i) => (
              <option key={`${item.run_id}-${i}`} value={i}>
                {item.name} · {fmtMs(item.duration_ms)} · {item.status}
              </option>
            ))}
          </select>
          <label className="load">
            open file
            <input
              type="file"
              accept="application/json,.json"
              multiple
              onChange={(e) => { void ingest(e.target.files); e.target.value = ""; }}
            />
          </label>
        </div>
      </header>

      {trace.error && (
        <div className="banner">
          <strong>{trace.error.type}</strong>
          <span>{trace.error.message}</span>
        </div>
      )}

      <main className="stage">
        <section className="stage-main">
          <GraphCanvas
            trace={trace}
            selectedNodeId={selectedStep?.node_id ?? null}
            onSelectNode={selectNode}
          />
          <Waterfall trace={trace} selectedStepId={selectedStepId} onSelectStep={selectStep} />
        </section>

        <aside className="stage-side">
          <Inspector trace={trace} step={selectedStep} />
        </aside>
      </main>

      {dropping && <div className="dropzone">Release to load trace</div>}
      {notice && <div className="notice" role="status">{notice}</div>}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warn" | "fault" }) {
  return (
    <div className={`metric ${tone ? `is-${tone}` : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
