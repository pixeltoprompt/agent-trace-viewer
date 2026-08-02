// trace.ts — Agent Trace Format v1.0
// Drop into the viewer at src/lib/trace.ts

export type Status = "success" | "error";

export interface TraceError {
  type: string;
  message: string;
}

export interface TraceNode {
  id: string;
  label: string;
  type: "start" | "node" | "end";
}

export interface TraceEdge {
  from: string;
  to: string;
  conditional: boolean;
  label: string | null;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  ts_start: number;
  ts_end: number;
  duration_ms: number;
  status: Status;
  error: TraceError | null;
}

export interface LlmCall {
  id: string;
  model: string | null;
  ts_start: number;
  ts_end: number;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  status: Status;
  error: TraceError | null;
}

export interface Step {
  step_id: string;
  node_id: string;
  step_index: number;
  attempt: number;
  ts_start: number;
  ts_end: number;
  duration_ms: number;
  status: Status;
  error: TraceError | null;
  state_before: unknown;
  state_after: unknown;
  output: unknown;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  tool_calls: ToolCall[];
  llm_calls: LlmCall[];
}

export interface Totals {
  steps: number;
  failed_steps: number;
  retries: number;
  tool_calls: number;
  llm_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

export interface Trace {
  trace_version: string;
  run_id: string;
  name: string;
  ts_start: number;
  ts_end: number;
  duration_ms: number;
  status: Status;
  error: TraceError | null;
  input: unknown;
  output: unknown;
  totals: Totals;
  nodes: TraceNode[];
  edges: TraceEdge[];
  steps: Step[];
}

/** Minimal runtime guard — enough to reject a dropped file that isn't a trace. */
export function isTrace(value: unknown): value is Trace {
  const t = value as Trace;
  return (
    !!t &&
    typeof t === "object" &&
    typeof t.run_id === "string" &&
    Array.isArray(t.steps) &&
    Array.isArray(t.nodes) &&
    typeof t.totals === "object"
  );
}

/** Waterfall geometry: fractions of total run duration, 0–1. */
export function laneGeometry(trace: Trace, step: Step) {
  const span = Math.max(trace.duration_ms, 1);
  return {
    left: (step.ts_start - trace.ts_start) / span,
    width: Math.max(step.duration_ms / span, 0.004), // floor so 0ms steps stay visible
  };
}

/** Per-node rollup, for colouring the graph canvas. */
export function nodeStats(trace: Trace) {
  const map = new Map<
    string,
    { runs: number; failed: number; retried: boolean; duration_ms: number; cost_usd: number }
  >();
  for (const step of trace.steps) {
    const entry =
      map.get(step.node_id) ??
      { runs: 0, failed: 0, retried: false, duration_ms: 0, cost_usd: 0 };
    entry.runs += 1;
    if (step.status === "error") entry.failed += 1;
    if (step.attempt > 1) entry.retried = true;
    entry.duration_ms += step.duration_ms;
    entry.cost_usd += step.cost_usd;
    map.set(step.node_id, entry);
  }
  return map;
}

export type DiffKind = "added" | "removed" | "changed" | "unchanged";

export interface DiffRow {
  path: string;
  kind: DiffKind;
  before: unknown;
  after: unknown;
}

/**
 * Flat recursive diff between two state objects.
 * Powers the State Diff tab — deliberately flat (dotted paths) so it renders as a
 * simple list instead of a nested tree component.
 */
export function diffState(before: unknown, after: unknown, path = ""): DiffRow[] {
  const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);

  if (isObj(before) && isObj(after)) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    return keys.flatMap((key) => {
      const next = path ? `${path}.${key}` : key;
      if (!(key in a)) return [{ path: next, kind: "added" as const, before: undefined, after: b[key] }];
      if (!(key in b)) return [{ path: next, kind: "removed" as const, before: a[key], after: undefined }];
      return diffState(a[key], b[key], next);
    });
  }

  const same = JSON.stringify(before) === JSON.stringify(after);
  return [{ path: path || "(root)", kind: same ? "unchanged" : "changed", before, after }];
}

export const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`);
export const fmtCost = (usd: number) => (usd === 0 ? "$0" : `$${usd.toFixed(4)}`);
export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
