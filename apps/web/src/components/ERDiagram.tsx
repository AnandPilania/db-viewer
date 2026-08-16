import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, { Background, Controls, MiniMap, ReactFlowProvider, type Edge, type Node } from "reactflow";
import dagre from "dagre";
import "reactflow/dist/style.css";
import { api } from "@/lib/api";
import { TableNode } from "@/components/TableNode";

const nodeTypes = { table: TableNode };

const NODE_WIDTH = 256;
const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 30;

function layout(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) {
    const height = HEADER_HEIGHT + (node.data.columns?.length ?? 1) * ROW_HEIGHT;
    g.setNode(node.id, { width: NODE_WIDTH, height: Math.min(height, 280) });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }
  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return { ...node, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - pos.height / 2 } };
  });
}

interface Props {
  connectionId: string;
}

export function ERDiagram({ connectionId }: Props) {
  const { data: tables, isLoading } = useQuery({
    queryKey: ["tables", connectionId],
    queryFn: () => api.listTables(connectionId),
  });

  const { nodes, edges } = useMemo(() => {
    if (!tables) return { nodes: [], edges: [] };

    const rawNodes: Node[] = tables.map((t) => ({
      id: t.name,
      type: "table",
      position: { x: 0, y: 0 },
      data: t,
    }));

    const rawEdges: Edge[] = [];
    for (const t of tables) {
      for (const col of t.columns) {
        if (col.isForeignKey && col.references) {
          rawEdges.push({
            id: `${t.name}.${col.name}->${col.references.table}.${col.references.column}`,
            source: t.name,
            sourceHandle: col.name,
            target: col.references.table,
            targetHandle: col.references.column,
            animated: false,
            style: { stroke: "hsl(200 90% 55% / 0.6)" },
          });
        }
      }
    }

    return { nodes: layout(rawNodes, rawEdges), edges: rawEdges };
  }, [tables]);

  if (isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading schema…</div>;
  }

  if (!tables || tables.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No tables found.</div>;
  }

  return (
    <div className="h-full w-full">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          className="bg-background"
        >
          <Background color="hsl(240 4% 20%)" gap={20} />
          <Controls />
          <MiniMap
            pannable
            zoomable
            className="!bg-card"
            maskColor="rgba(0,0,0,0.6)"
            nodeColor="hsl(200 90% 55% / 0.4)"
          />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
