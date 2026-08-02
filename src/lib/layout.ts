// layout.ts — layered top-down layout for agent graphs. No dagre, no dependencies.
// Drop into src/lib/layout.ts
//
// Agent graphs are small (5–20 nodes) but not always acyclic — retry loops and
// supervisor patterns create back edges. Strategy: strip back edges, rank the
// remaining DAG by longest path, then order within each rank by barycenter sweeps
// to reduce crossings. Back edges are still drawn, they just don't affect ranking.

import type { TraceEdge, TraceNode } from "./trace";

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  rankGap?: number;
  siblingGap?: number;
}

export interface Point {
  x: number;
  y: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  nodeWidth: 196,
  nodeHeight: 76,
  rankGap: 88,
  siblingGap: 28,
};

/** DFS colouring: any edge into a node currently on the stack is a back edge. */
function findBackEdges(ids: string[], edges: TraceEdge[]): Set<number> {
  const out = new Map<string, number[]>();
  edges.forEach((edge, i) => {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from)!.push(i);
  });

  const state = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 on stack, 2 done
  const back = new Set<number>();

  const visit = (id: string) => {
    state.set(id, 1);
    for (const i of out.get(id) ?? []) {
      const target = edges[i].to;
      const s = state.get(target) ?? 0;
      if (s === 1) back.add(i);
      else if (s === 0) visit(target);
    }
    state.set(id, 2);
  };

  for (const id of ids) if ((state.get(id) ?? 0) === 0) visit(id);
  return back;
}

export function layoutGraph(
  nodes: TraceNode[],
  edges: TraceEdge[],
  options: LayoutOptions = {},
): Map<string, Point> {
  const { nodeWidth, nodeHeight, rankGap, siblingGap } = { ...DEFAULTS, ...options };
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const valid = edges.filter((e) => known.has(e.from) && known.has(e.to));

  const back = findBackEdges(ids, valid);
  const forward = valid.filter((_, i) => !back.has(i));

  // --- rank by longest path ------------------------------------------------ //
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const edge of forward) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
    if (!parents.has(edge.to)) parents.set(edge.to, []);
    parents.get(edge.to)!.push(edge.from);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const pending = new Map(indegree);
  const visited = new Set<string>(queue);

  while (queue.length) {
    const id = queue.shift()!;
    for (const child of children.get(id) ?? []) {
      rank.set(child, Math.max(rank.get(child) ?? 0, (rank.get(id) ?? 0) + 1));
      pending.set(child, (pending.get(child) ?? 1) - 1);
      if ((pending.get(child) ?? 0) === 0 && !visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  }
  // anything unreachable (disconnected subgraph) keeps rank 0

  // --- order within rank, barycenter sweeps -------------------------------- //
  const rows = new Map<number, string[]>();
  for (const id of ids) {
    const r = rank.get(id) ?? 0;
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)!.push(id);
  }
  const rankKeys = Array.from(rows.keys()).sort((a, b) => a - b);

  const indexOf = new Map<string, number>();
  const reindex = () => {
    for (const r of rankKeys) rows.get(r)!.forEach((id, i) => indexOf.set(id, i));
  };
  reindex();

  const sweep = (relatives: Map<string, string[]>, order: number[]) => {
    for (const r of order) {
      const row = rows.get(r)!;
      const scored = row.map((id, i) => {
        const kin = (relatives.get(id) ?? []).map((k) => indexOf.get(k) ?? 0);
        const bary = kin.length ? kin.reduce((a, b) => a + b, 0) / kin.length : i;
        return { id, bary, i };
      });
      scored.sort((a, b) => a.bary - b.bary || a.i - b.i);
      rows.set(r, scored.map((s) => s.id));
      reindex();
    }
  };

  for (let pass = 0; pass < 4; pass++) {
    sweep(parents, rankKeys);
    sweep(children, [...rankKeys].reverse());
  }

  // --- coordinates --------------------------------------------------------- //
  const positions = new Map<string, Point>();
  for (const r of rankKeys) {
    const row = rows.get(r)!;
    const span = row.length * nodeWidth + (row.length - 1) * siblingGap;
    row.forEach((id, i) => {
      positions.set(id, {
        x: -span / 2 + i * (nodeWidth + siblingGap),
        y: r * (nodeHeight + rankGap),
      });
    });
  }
  return positions;
}

/** Edge keys ("from→to") that the run actually traversed, in order. */
export function executedEdgeKeys(
  steps: { node_id: string }[],
  edges: TraceEdge[],
): Set<string> {
  const exists = new Set(edges.map((e) => `${e.from}→${e.to}`));
  const walked = new Set<string>();
  const path = steps.map((s) => s.node_id);

  if (path.length) {
    const first = `__start__→${path[0]}`;
    if (exists.has(first)) walked.add(first);
    const last = `${path[path.length - 1]}→__end__`;
    if (exists.has(last)) walked.add(last);
  }
  for (let i = 0; i < path.length - 1; i++) {
    const key = `${path[i]}→${path[i + 1]}`;
    if (exists.has(key)) walked.add(key);
  }
  return walked;
}
