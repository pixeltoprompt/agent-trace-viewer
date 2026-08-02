// StepNode.tsx — custom React Flow node. Drop into src/components/StepNode.tsx
//
// Encoding, kept strictly one-signal-per-channel:
//   fill / opacity  -> did this node execute in this run
//   stacked plates  -> how many times it ran (attempts)
//   fault colour    -> the only saturated colour on the canvas
//   monospace slab  -> measured values only, never labels

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { fmtCost, fmtMs } from "../lib/trace";

export interface StepNodeData {
  label: string;
  kind: "start" | "node" | "end";
  executed: boolean;
  runs: number;
  failed: number;
  retried: boolean;
  durationMs: number;
  costUsd: number;
  tokens: number;
  active: boolean;
  [key: string]: unknown;
}

export function StepNode({ data }: NodeProps) {
  const d = data as StepNodeData;

  if (d.kind === "start" || d.kind === "end") {
    return (
      <div className={`terminal ${d.executed ? "is-live" : ""}`}>
        {d.kind === "end" && <Handle type="target" position={Position.Top} />}
        <span>{d.kind === "start" ? "start" : "end"}</span>
        {d.kind === "start" && <Handle type="source" position={Position.Bottom} />}
      </div>
    );
  }

  const state = d.failed > 0 ? "is-fault" : d.executed ? "is-live" : "is-idle";
  const plates = Math.min(d.runs, 3); // 3 plates reads as "3 or more"

  return (
    <div className={`node-shell ${state} ${d.active ? "is-active" : ""}`}>
      <Handle type="target" position={Position.Top} />

      {/* one plate per attempt, offset behind the face */}
      {Array.from({ length: Math.max(plates - 1, 0) }, (_, i) => (
        <div key={i} className="plate" style={{ transform: `translate(${(i + 1) * 4}px, ${(i + 1) * 4}px)` }} />
      ))}

      <div className="node-face">
        <div className="node-head">
          <span className="node-label">{d.label}</span>
          {d.retried && <span className="badge" title={`${d.runs} attempts`}>×{d.runs}</span>}
        </div>

        {d.executed ? (
          <div className="node-meter">
            <span className="meter-value">{fmtMs(d.durationMs)}</span>
            {d.costUsd > 0 && <span className="meter-value dim">{fmtCost(d.costUsd)}</span>}
            {d.failed > 0 && <span className="meter-fault">fault</span>}
          </div>
        ) : (
          <div className="node-meter">
            <span className="meter-value dim">not reached</span>
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const nodeTypes = { step: StepNode };
