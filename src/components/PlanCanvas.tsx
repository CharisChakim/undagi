// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { FileText, LayoutGrid, Layers, ChevronRight, Maximize } from "lucide-react";
import { FeatureSpec } from "../types";
import { useT, TFunction } from "../lib/i18n";

// Metrik tata letak. Node selebar 224 (w-56) dengan kolom di x 0 / 420 / 780 dan
// fitur berjarak 200 secara vertikal — diambil dari mengukur kanvas referensi.
const COLUMN_X = [0, 420, 780];
const ROW_GAP = 200;
const SUB_FEATURES_SHOWN = 3;

// fitView memperkecil sampai SEMUA muat, dan dengan enam fitur itu berarti
// tinggi ~1100px dijejalkan ke kanvas 600px — kartu jadi tak terbaca. Batas
// bawah 0.75 membalik prioritasnya: keterbacaan dulu, sisanya digulung. Batas
// ini hanya berlaku untuk fitView; minZoom pada instance tetap longgar, dan
// tombol fit bawaan React Flow di kiri bawah tetap bisa memuat semuanya.
const FIT_VIEW: FitViewOptions = { padding: 0.15, minZoom: 0.75, maxZoom: 1 };

const CARD = "w-56 rounded-xl px-3.5 py-3 bg-surface border border-line shadow-elev-1";

const PRIORITY_LABEL: Record<string, string> = { P0: "MVP", P1: "IMPORTANT", P2: "LATER" };

function PlanRootNode({ data }: NodeProps) {
  const { title, t } = data as { title: string; t: TFunction };
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 shrink-0 rounded-lg bg-accent-soft text-accent-ink grid place-items-center">
          <FileText className="w-4 h-4" />
        </span>
        <span className="font-semibold text-ink truncate">{title}</span>
      </div>
      <p className="text-xs text-faint mt-2">{t("Planning")}</p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function FeatureNode({ data }: NodeProps) {
  const { name, description, priority, t } = data as {
    name: string;
    description: string;
    priority: string;
    t: TFunction;
  };
  return (
    <div className={`${CARD} relative`}>
      {priority && (
        <span className="absolute -top-2 right-3 px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide bg-accent text-accent-fg">
          {t(PRIORITY_LABEL[priority] || priority)}
        </span>
      )}
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 shrink-0 rounded-lg bg-subtle text-muted grid place-items-center">
          <LayoutGrid className="w-4 h-4" />
        </span>
        <span className="font-semibold text-ink truncate">{name}</span>
      </div>
      <p className="text-xs text-faint mt-2 line-clamp-2">{description}</p>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function SubFeaturesNode({ data }: NodeProps) {
  const { items, t } = data as { items: string[]; t: TFunction };
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, SUB_FEATURES_SHOWN);
  const hidden = items.length - visible.length;

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2 mb-2.5">
        <Layers className="w-3.5 h-3.5 text-faint" />
        <span className="text-xs font-medium text-faint">{t("Sub features")}</span>
      </div>

      <ul className="space-y-1.5">
        {visible.map((item, idx) => (
          <li key={idx} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-subtle text-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-strong shrink-0" />
            <span className="text-xs truncate">{item}</span>
          </li>
        ))}
      </ul>

      {(hidden > 0 || expanded) && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 ml-auto flex items-center gap-1 text-xs text-faint hover:text-ink transition-colors"
        >
          {expanded ? t("Show fewer") : t("Show all ({count})", { count: items.length })}
          <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
      )}

      <Handle type="target" position={Position.Left} />
    </div>
  );
}

const nodeTypes = {
  planRoot: PlanRootNode,
  feature: FeatureNode,
  subFeatures: SubFeaturesNode,
};

interface PlanCanvasProps {
  title: string;
  features: FeatureSpec[];
}

export const PlanCanvas: React.FC<PlanCanvasProps> = ({ title, features }) => {
  // Node React Flow dirender di luar pohon React biasa, jadi tidak bisa memanggil
  // useT() sendiri; t dititipkan lewat data node.
  const { t } = useT();

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    // Root diletakkan sejajar dengan tengah kolom fitur.
    const centerY = ((features.length - 1) * ROW_GAP) / 2;

    nodes.push({
      id: "root",
      type: "planRoot",
      position: { x: COLUMN_X[0], y: centerY },
      data: { title, t },
      draggable: false,
    });

    features.forEach((feature, idx) => {
      const featureId = `feature-${idx}`;
      nodes.push({
        id: featureId,
        type: "feature",
        position: { x: COLUMN_X[1], y: idx * ROW_GAP },
        data: { name: feature.name, description: feature.description, priority: feature.priority, t },
      });
      edges.push({ id: `root-${featureId}`, source: "root", target: featureId });

      const subFeatures = feature.subFeatures || [];
      if (subFeatures.length === 0) return;

      const subId = `sub-${idx}`;
      nodes.push({
        id: subId,
        type: "subFeatures",
        position: { x: COLUMN_X[2], y: idx * ROW_GAP },
        data: { items: subFeatures, t },
      });
      edges.push({ id: `${featureId}-${subId}`, source: featureId, target: subId });
    });

    return { nodes, edges };
  }, [title, features, t]);

  // Instance disimpan saat init supaya tombol reset di luar kanvas bisa memanggil
  // fitView tanpa harus menjadi anak dari <ReactFlow>.
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);

  return (
    <div className="relative h-[600px] rounded-xl overflow-hidden border border-line bg-subtle">
      <button
        onClick={() => flow?.fitView({ ...FIT_VIEW, duration: 300 })}
        disabled={!flow}
        title={t("Back to the default view")}
        className="absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg
          bg-surface border border-line text-xs font-medium text-muted hover:text-ink shadow-elev-1
          lift disabled:opacity-40"
      >
        <Maximize className="w-3.5 h-3.5" />
        {t("Reset view")}
      </button>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setFlow}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.3}
        maxZoom={1.75}
        proOptions={{ hideAttribution: false }}
        nodesConnectable={false}
        edgesFocusable={false}
        nodeOrigin={[0, 0.5]}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--app-strong)" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </div>
  );
};
