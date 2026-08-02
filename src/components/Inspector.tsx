// Inspector.tsx — Drop into src/components/Inspector.tsx (replaces the placeholder)
//
// State diff leads, because it's the question you actually open a debugger to answer:
// what did this node change? Output, tool calls and model calls sit behind it.
//
// Colour vocabulary is inherited, not invented: green means "this run did this"
// (added), amber means "attention, not failure" (changed, retries), ember is reserved
// for faults everywhere in the app.

import { useMemo, useState, type ReactNode } from "react";
import type { DiffRow, LlmCall, Step, ToolCall, Trace } from "../lib/trace";
import { diffState, fmtCost, fmtMs, fmtTokens } from "../lib/trace";
import "../styles/inspector.css";

type TabKey = "diff" | "output" | "tools" | "models";

export function Inspector({ trace, step }: { trace: Trace; step: Step | null }) {
  const [tab, setTab] = useState<TabKey>("diff");
  const [changedOnly, setChangedOnly] = useState(true);
  const [copied, setCopied] = useState(false);

  const rows = useMemo(
    () => (step ? diffState(step.state_before, step.state_after) : []),
    [step],
  );
  const changed = useMemo(() => rows.filter((r) => r.kind !== "unchanged"), [rows]);

  if (!step) {
    return (
      <div className="ins is-empty">
        <p className="ins-hint">Select a node or a lane to inspect it.</p>
        <p className="ins-hint dim">
          {trace.totals.steps} steps · {trace.totals.tool_calls} tool calls
        </p>
        <p className="ins-hint dim">↑ ↓ moves through the timeline</p>
      </div>
    );
  }

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "diff", label: "state diff", count: changed.length },
    { key: "output", label: "output" },
    { key: "tools", label: "tools", count: step.tool_calls.length },
    { key: "models", label: "models", count: step.llm_calls.length },
  ];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(step, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const cycle = (dir: number) => {
    const i = tabs.findIndex((t) => t.key === tab);
    setTab(tabs[(i + dir + tabs.length) % tabs.length].key);
  };

  const visible = changedOnly ? changed : rows;

  return (
    <div className="ins">
      <header className="ins-head">
        <div className="ins-title">
          <span className="ins-node">{step.node_id}</span>
          {step.attempt > 1 && <span className="tag is-warn">attempt {step.attempt}</span>}
          {step.status === "error" && <span className="tag is-fault">fault</span>}
        </div>
        <button className="ins-copy" onClick={copy} title="Copy this step as JSON">
          {copied ? "copied" : "copy json"}
        </button>
      </header>

      <dl className="ins-stats">
        <div><dt>duration</dt><dd>{fmtMs(step.duration_ms)}</dd></div>
        <div><dt>tokens</dt><dd>{fmtTokens(step.tokens_in)}→{fmtTokens(step.tokens_out)}</dd></div>
        <div><dt>cost</dt><dd>{fmtCost(step.cost_usd)}</dd></div>
        <div><dt>step</dt><dd>{step.step_index + 1}/{trace.totals.steps}</dd></div>
      </dl>

      {step.error && (
        <div className="ins-fault">
          <strong>{step.error.type}</strong>
          <span>{step.error.message}</span>
        </div>
      )}

      <div className="ins-tabs" role="tablist" aria-label="Step detail">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`ins-tab ${tab === t.key ? "is-on" : ""}`}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") { e.preventDefault(); cycle(1); }
              if (e.key === "ArrowLeft") { e.preventDefault(); cycle(-1); }
            }}
          >
            {t.label}
            {t.count !== undefined && <span className="ins-count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div className="ins-body" role="tabpanel">
        {tab === "diff" && (
          <>
            <label className="ins-toggle">
              <input
                type="checkbox"
                checked={changedOnly}
                onChange={(e) => setChangedOnly(e.target.checked)}
              />
              changes only
            </label>

            {visible.length === 0 ? (
              <Empty>
                {changedOnly
                  ? "This node returned no state changes."
                  : "No state recorded for this step."}
              </Empty>
            ) : (
              <ul className="diff">
                {visible.map((row) => <DiffLine key={row.path} row={row} />)}
              </ul>
            )}
          </>
        )}

        {tab === "output" && (
          step.output === null || step.output === undefined ? (
            <Empty>
              {step.status === "error"
                ? "The node raised before returning."
                : "This node returned nothing."}
            </Empty>
          ) : (
            <Json value={step.output} />
          )
        )}

        {tab === "tools" && (
          step.tool_calls.length === 0 ? (
            <Empty>No tools were called in this step.</Empty>
          ) : (
            <ul className="calls">
              {step.tool_calls.map((call) => <ToolRow key={call.id} call={call} />)}
            </ul>
          )
        )}

        {tab === "models" && (
          step.llm_calls.length === 0 ? (
            <Empty>No model calls in this step.</Empty>
          ) : (
            <ul className="calls">
              {step.llm_calls.map((call) => <ModelRow key={call.id} call={call} />)}
            </ul>
          )
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ parts -- */

const GLYPH: Record<DiffRow["kind"], string> = {
  added: "+",
  removed: "−",
  changed: "→",
  unchanged: "·",
};

function DiffLine({ row }: { row: DiffRow }) {
  const stacked =
    preview(row.before).length + preview(row.after).length > 64 ||
    (row.before !== null && typeof row.before === "object") ||
    (row.after !== null && typeof row.after === "object");

  return (
    <li className={`diff-row is-${row.kind}`}>
      <span className="diff-glyph" aria-hidden>{GLYPH[row.kind]}</span>
      <span className="diff-path">{row.path}</span>
      <div className={`diff-vals ${stacked ? "is-stacked" : ""}`}>
        {row.kind !== "added" && <code className="was">{preview(row.before)}</code>}
        {row.kind === "changed" && <span className="diff-arrow" aria-hidden>→</span>}
        {row.kind !== "removed" && <code className="now">{preview(row.after)}</code>}
      </div>
    </li>
  );
}

function ToolRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`call ${call.status === "error" ? "is-fault" : ""}`}>
      <button className="call-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="call-chevron" aria-hidden>{open ? "▾" : "▸"}</span>
        <span className="call-name">{call.name}</span>
        <span className="call-meta">{fmtMs(call.duration_ms)}</span>
      </button>
      {call.error && <p className="call-error">{call.error.type}: {call.error.message}</p>}
      {open && (
        <div className="call-body">
          <h4>input</h4>
          <Json value={call.input} />
          {call.status !== "error" && (
            <>
              <h4>output</h4>
              <Json value={call.output} />
            </>
          )}
        </div>
      )}
    </li>
  );
}

function ModelRow({ call }: { call: LlmCall }) {
  return (
    <li className={`call ${call.status === "error" ? "is-fault" : ""}`}>
      <div className="call-head is-static">
        <span className="call-name">{call.model ?? "unknown model"}</span>
        <span className="call-meta">{fmtMs(call.duration_ms)}</span>
      </div>
      <dl className="call-stats">
        <div><dt>in</dt><dd>{call.tokens_in.toLocaleString()}</dd></div>
        <div><dt>out</dt><dd>{call.tokens_out.toLocaleString()}</dd></div>
        <div><dt>cost</dt><dd>{fmtCost(call.cost_usd)}</dd></div>
      </dl>
      {call.error && <p className="call-error">{call.error.type}: {call.error.message}</p>}
    </li>
  );
}

function Json({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }, [value]);
  return <pre className="json">{text}</pre>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="ins-empty">{children}</p>;
}

/** Compact one-line preview of any value, for diff rows. */
function preview(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    const body = JSON.stringify(value);
    return body.length > 120 ? `${value.length} items · ${body.slice(0, 90)}…` : body;
  }
  const body = JSON.stringify(value);
  return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}
