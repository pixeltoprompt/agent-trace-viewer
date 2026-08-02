// GraphCanvas.tsx — Drop into src/components/GraphCanvas.tsx
//
// Renders trace topology. Owns no state beyond React Flow's own viewport: selection
// is lifted so the timeline and inspector stay in sync with the canvas.

import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { Trace } from "../lib/trace";
import { nodeStats } from "../lib/trace";
import { executedEdgeKeys, layoutGraph } from "../lib/layout";
import { nodeTypes, type StepNodeData } from "./StepNode";

interface GraphCanvasProps {
  trace: Trace;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
}

export function GraphCanvas({ trace, selectedNodeId, onSelectNode }: GraphCanvasProps) {
  const { nodes, edges } = useMemo(() => {
    const positions = layoutGraph(trace.nodes, trace.edges);
    const stats = nodeStats(trace);
    const walked = executedEdgeKeys(trace.steps, trace.edges);

    const tokensByNode = new Map<string, number>();
    for (const step of trace.steps) {
      tokensByNode.set(
        step.node_id,
        (tokensByNode.get(step.node_id) ?? 0) + step.tokens_in + step.tokens_out,
      );
    }

    const flowNodes: Node[] = trace.nodes.map((node) => {
      const s = stats.get(node.id);
      const terminalLive =
        node.type === "start"
          ? walked.size > 0
          : node.type === "end"
            ? trace.status === "success"
            : false;

      const data: StepNodeData = {
        label: node.label,
        kind: node.type,
        executed: node.type === "node" ? !!s : terminalLive,
        runs: s?.runs ?? 0,
        failed: s?.failed ?? 0,
        retried: s?.retried ?? false,
        durationMs: s?.duration_ms ?? 0,
        costUsd: s?.cost_usd ?? 0,
        tokens: tokensByNode.get(node.id) ?? 0,
        active: selectedNodeId === node.id,
      };

      return {
        id: node.id,
        type: "step",
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: data as unknown as Record<string, unknown>,
        draggable: true,
        selectable: node.type === "node",
      };
    });

    const flowEdges: Edge[] = trace.edges.map((edge, i) => {
      const key = `${edge.from}→${edge.to}`;
      const live = walked.has(key);
      return {
        id: `e${i}-${key}`,
        source: edge.from,
        target: edge.to,
        label: edge.label ?? undefined,
        type: "smoothstep",
        animated: false,
        className: live ? "edge-live" : "edge-idle",
        style: {
          strokeWidth: live ? 1.75 : 1,
          strokeDasharray: edge.conditional ? "5 4" : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      };
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [trace, selectedNodeId]);

  return (
    <div className="canvas-frame">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
        minZoom={0.3}
        maxZoom={1.8}
        proOptions={{ hideAttribution: false }}
        onNodeClick={(_, node) => onSelectNode?.(node.id)}
        onPaneClick={() => onSelectNode?.(null)}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="canvas-grid" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      <div className="canvas-key">
        <span><i className="key-swatch live" />executed</span>
        <span><i className="key-swatch idle" />not reached</span>
        <span><i className="key-swatch fault" />fault</span>
        <span><i className="key-dash" />conditional</span>
      </div>
    </div>
  );
}
