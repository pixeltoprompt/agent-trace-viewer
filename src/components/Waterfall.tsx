// Waterfall.tsx — Drop into src/components/Waterfall.tsx
//
// One lane per step, in execution order. The step bar is the node's wall-clock
// span; the two ribbons beneath it are the LLM and tool calls that happened
// inside it, positioned on the same absolute time axis. Anything on the axis that
// no step covers is graph overhead — routing, checkpointing, state merges — and it
// gets its own strip, because "where did the other 400ms go" is the question this
// view exists to answer.

import { useMemo, useRef } from "react";
import type { Step, Trace } from "../lib/trace";
import { fmtMs, laneGeometry } from "../lib/trace";

interface WaterfallProps {
  trace: Trace;
  selectedStepId?: string | null;
  onSelectStep?: (step: Step | null) => void;
}

/** Axis ticks on 1/2/5×10ⁿ boundaries so labels read as round numbers. */
export function niceTicks(durationMs: number, target = 6): number[] {
  if (durationMs <= 0) return [0];
  const raw = durationMs / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // floor at 1ms: sub-target durations otherwise produce fractional steps that
  // round to duplicate tick values (and duplicate React keys)
  const step = Math.max(1, (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag);
  const ticks: number[] = [];
  for (let t = 0; t <= durationMs; t += step) ticks.push(Math.round(t));
  return ticks;
}

/** Spans on the axis covered by no step — i.e. time the graph spent on itself. */
export function overheadSpans(trace: Trace): { start: number; end: number }[] {
  const busy = trace.steps
    .map((s) => ({ start: s.ts_start, end: s.ts_end }))
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const span of busy) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const gaps: { start: number; end: number }[] = [];
  let cursor = trace.ts_start;
  for (const span of merged) {
    if (span.start > cursor) gaps.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (trace.ts_end > cursor) gaps.push({ start: cursor, end: trace.ts_end });
  return gaps.filter((g) => g.end - g.start > 0);
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

export function Waterfall({ trace, selectedStepId, onSelectStep }: WaterfallProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const span = Math.max(trace.duration_ms, 1);

  const ticks = useMemo(() => niceTicks(trace.duration_ms), [trace.duration_ms]);
  const gaps = useMemo(() => overheadSpans(trace), [trace]);
  const overheadMs = gaps.reduce((sum, g) => sum + (g.end - g.start), 0);

  const move = (delta: number) => {
    const index = trace.steps.findIndex((s) => s.step_id === selectedStepId);
    const next = trace.steps[Math.min(Math.max(index + delta, 0), trace.steps.length - 1)];
    if (next) onSelectStep?.(next);
  };

  return (
    <div
      className="wf"
      ref={listRef}
      tabIndex={0}
      role="list"
      aria-label="Step timeline"
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
        if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
        if (e.key === "Escape") onSelectStep?.(null);
      }}
    >
      {/* ---------------------------------------------------------- ruler -- */}
      <div className="wf-row wf-ruler">
        <div className="wf-gutter">
          <span className="wf-axis-label">elapsed</span>
        </div>
        <div className="wf-track">
          {ticks.map((t) => (
            <span key={t} className="wf-tick" style={{ left: pct(t / span) }}>
              <i />
              <em>{fmtMs(t)}</em>
            </span>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------- overhead -- */}
      {overheadMs > 0 && (
        <div className="wf-row wf-overhead" role="listitem">
          <div className="wf-gutter">
            <span className="wf-node">graph overhead</span>
            <span className="wf-sub">{fmtMs(overheadMs)}</span>
          </div>
          <div className="wf-track">
            {gaps.map((g, i) => (
              <span
                key={i}
                className="wf-gap"
                style={{
                  left: pct((g.start - trace.ts_start) / span),
                  width: pct(Math.max((g.end - g.start) / span, 0.002)),
                }}
                title={`${fmtMs(g.end - g.start)} between nodes`}
              />
            ))}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------------- steps -- */}
      {trace.steps.map((step) => {
        const geo = laneGeometry(trace, step);
        const active = step.step_id === selectedStepId;
        const state = step.status === "error" ? "is-fault" : "is-ok";

        return (
          <div
            key={step.step_id}
            role="listitem"
            aria-current={active}
            className={`wf-row wf-step ${state} ${active ? "is-active" : ""}`}
            onClick={() => onSelectStep?.(step)}
          >
            <div className="wf-gutter">
              <span className="wf-index">{String(step.step_index + 1).padStart(2, "0")}</span>
              <span className="wf-node" title={step.node_id}>{step.node_id}</span>
              {step.attempt > 1 && <span className="wf-attempt">try {step.attempt}</span>}
            </div>

            <div className="wf-track">
              <span
                className="wf-bar"
                style={{ left: pct(geo.left), width: pct(geo.width) }}
                title={`${step.node_id} — ${fmtMs(step.duration_ms)}`}
              >
                <em className="wf-bar-label">{fmtMs(step.duration_ms)}</em>
              </span>

              {step.llm_calls.map((call) => (
                <span
                  key={call.id}
                  className={`wf-ribbon is-llm ${call.status === "error" ? "is-fault" : ""}`}
                  style={{
                    left: pct((call.ts_start - trace.ts_start) / span),
                    width: pct(Math.max(call.duration_ms / span, 0.002)),
                  }}
                  title={`${call.model ?? "llm"} — ${fmtMs(call.duration_ms)} · ${call.tokens_in}→${call.tokens_out} tok`}
                />
              ))}

              {step.tool_calls.map((call) => (
                <span
                  key={call.id}
                  className={`wf-ribbon is-tool ${call.status === "error" ? "is-fault" : ""}`}
                  style={{
                    left: pct((call.ts_start - trace.ts_start) / span),
                    width: pct(Math.max(call.duration_ms / span, 0.002)),
                  }}
                  title={`${call.name} — ${fmtMs(call.duration_ms)}`}
                />
              ))}
            </div>
          </div>
        );
      })}

      <div className="wf-key">
        <span><i className="wf-key-bar" />node</span>
        <span><i className="wf-key-ribbon is-llm" />model call</span>
        <span><i className="wf-key-ribbon is-tool" />tool call</span>
        <span><i className="wf-key-gap" />between nodes</span>
      </div>
    </div>
  );
}
