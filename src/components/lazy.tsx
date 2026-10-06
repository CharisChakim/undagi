// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { Suspense } from "react";

// Mermaid (yang menarik cytoscape dan katex di belakangnya), React Flow, dan
// react-markdown adalah tiga paket terberat di bundel, dan ketiganya hanya
// dirender bersyarat di satu-dua tempat. Dimuat saat benar-benar dipakai,
// bukan saat aplikasi dibuka.
//
// Fallback sengaja dibuat seukuran komponen aslinya supaya halaman tidak
// melompat begitu chunk-nya tiba.

const MermaidViewerLazy = React.lazy(() =>
  import("./MermaidViewer").then((m) => ({ default: m.MermaidViewer }))
);

export const MermaidViewer: React.FC<React.ComponentProps<typeof MermaidViewerLazy>> = (props) => (
  <Suspense fallback={<div className="card min-h-[320px] animate-pulse" />}>
    <MermaidViewerLazy {...props} />
  </Suspense>
);

const PlanCanvasLazy = React.lazy(() =>
  import("./PlanCanvas").then((m) => ({ default: m.PlanCanvas }))
);

export const PlanCanvas: React.FC<React.ComponentProps<typeof PlanCanvasLazy>> = (props) => (
  <Suspense fallback={<div className="h-[600px] rounded-xl border border-line bg-subtle animate-pulse" />}>
    <PlanCanvasLazy {...props} />
  </Suspense>
);

const MarkdownBodyLazy = React.lazy(() => import("./MarkdownBody"));

// Fallback-nya teks mentah: markdown tetap terbaca apa adanya, jadi tidak ada
// yang hilang selama chunk-nya dalam perjalanan.
export const Markdown: React.FC<{ children: string }> = ({ children }) => (
  <Suspense fallback={<pre className="whitespace-pre-wrap font-sans">{children}</pre>}>
    <MarkdownBodyLazy>{children}</MarkdownBodyLazy>
  </Suspense>
);
