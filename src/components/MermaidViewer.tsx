// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import { Download, Code, Eye, Maximize2, Minimize2, ZoomIn, ZoomOut, RefreshCw, Copy, Check } from "lucide-react";
import { useT } from "../lib/i18n";
import { downloadFile } from "../lib/download";

interface MermaidViewerProps {
  chart: string;
  explanation?: string;
  title?: string;
}

// Diagram datang dari keluaran LLM dan SVG hasilnya dipasang lewat
// dangerouslySetInnerHTML, jadi securityLevel "strict" (bukan "loose") dipakai
// agar Mermaid menyanitasi labelnya. Konsekuensinya htmlLabels harus mati.
const initMermaid = (isDark: boolean) =>
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? "dark" : "neutral",
    securityLevel: "strict",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    flowchart: {
      useMaxWidth: false,
      htmlLabels: false,
      // "basis" tidak melewati titik kontrolnya, jadi garis membusur menjauh dari
      // titik tengah tempat Mermaid menaruh label edge — labelnya jadi terlihat
      // mengambang lepas dari garis. "linear" membuat label duduk di garisnya.
      curve: "linear",
    },
  });

export const MermaidViewer: React.FC<MermaidViewerProps> = ({ chart, explanation, title }) => {
  const { t } = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [svgContent, setSvgContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"visual" | "code">("visual");
  const [zoom, setZoom] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  // Warna bawaan Mermaid dipanggang ke dalam SVG saat render, jadi tema tidak
  // bisa ditumpangi CSS — diagram harus dirender ulang saat mode berganti.
  // Class .dark dipantau langsung, bukan diterima sebagai prop: penulisnya ada
  // dua (efek tema di App dan skrip anti-kedip di index.html), dan efek App
  // baru jalan setelah render sehingga membaca DOM saat render selalu telat
  // satu langkah.
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let isMounted = true;
    const renderDiagram = async () => {
      if (!chart) return;
      setError(null);

      try {
        initMermaid(isDark);
        const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;
        // Clean chart string
        let cleanedChart = chart.trim();
        if (cleanedChart.startsWith("```mermaid")) {
          cleanedChart = cleanedChart.replace(/^```mermaid\n?/, "").replace(/```$/, "");
        } else if (cleanedChart.startsWith("```")) {
          cleanedChart = cleanedChart.replace(/^```\n?/, "").replace(/```$/, "");
        }

        const { svg } = await mermaid.render(id, cleanedChart);
        if (isMounted) {
          setSvgContent(svg);
        }
      } catch (err: any) {
        console.error("Mermaid rendering error:", err);
        if (isMounted) {
          setError(t("Could not render the Mermaid diagram. Check the syntax below."));
        }
      }
    };

    renderDiagram();

    return () => {
      isMounted = false;
    };
  }, [chart, isDark]);

  const handleCopyCode = () => {
    navigator.clipboard.writeText(chart);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadSvg = () => {
    if (!svgContent) return;
    downloadFile(
      `${(title || "diagram_logika").toLowerCase().replace(/[^a-z0-9]/g, "_")}.svg`,
      svgContent,
      "image/svg+xml",
    );
  };

  const viewer = (
    <div className={`card overflow-hidden ${isFullscreen ? "fixed inset-4 z-50 flex flex-col shadow-elev-3" : ""}`}>
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-2.5 bg-subtle border-b border-line gap-3">
        <h4 className="font-medium text-ink text-sm truncate">{title || t("System logic diagram")}</h4>

        <div className="flex items-center gap-2">
          {/* View Toggle */}
          <div className="bg-surface border border-line p-0.5 rounded-lg flex items-center text-xs font-medium">
            <button
              onClick={() => setActiveTab("visual")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${activeTab === "visual" ? "bg-subtle text-ink" : "text-muted hover:text-ink"}`}
            >
              <Eye className="w-3.5 h-3.5" />
              {t("Diagram")}
            </button>
            <button
              onClick={() => setActiveTab("code")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors ${activeTab === "code" ? "bg-subtle text-ink" : "text-muted hover:text-ink"}`}
            >
              <Code className="w-3.5 h-3.5" />
              Mermaid
            </button>
          </div>

          {activeTab === "visual" && (
            <div className="flex items-center gap-0.5 bg-surface border border-line rounded-lg p-0.5 text-muted">
              <button onClick={() => setZoom((z) => Math.max(0.5, z - 0.2))} className="p-1 hover:text-ink rounded" title={t("Zoom out")}>
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-xs px-1 font-mono font-medium tabular-nums">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => Math.min(2.5, z + 0.2))} className="p-1 hover:text-ink rounded" title={t("Zoom in")}>
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => setZoom(1)} className="p-1 hover:text-ink rounded" title={t("Reset zoom")}>
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <button onClick={handleCopyCode} className="btn-outline text-xs !py-1.5" title={t("Copy Mermaid code")}>
            {copied ? <Check className="w-3.5 h-3.5 text-ok" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? t("Copied") : t("Copy code")}
          </button>

          <button
            onClick={handleDownloadSvg}
            disabled={!svgContent}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent-soft text-accent-ink rounded-lg text-xs font-medium hover:brightness-105 transition-[filter,opacity] disabled:opacity-50"
            title={t("Download SVG")}
          >
            <Download className="w-3.5 h-3.5" />
            {t("Export SVG")}
          </button>

          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1.5 border border-line bg-surface text-muted hover:text-ink rounded-lg transition-colors"
            title={isFullscreen ? t("Exit full screen") : t("Full screen")}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Main Container */}
      <div className={`p-6 bg-canvas overflow-auto flex-1 min-h-[320px] max-h-[600px] flex ${isFullscreen ? "max-h-none h-full" : ""}`}>
        {activeTab === "visual" ? (
          error ? (
            <div className="m-auto text-center p-6 bg-warn-soft rounded-xl border border-warn/30 max-w-lg">
              <p className="text-warn-ink text-sm font-medium mb-2">{error}</p>
              <p className="text-xs text-warn-ink/80 mb-3">{t('You can still read and copy the Mermaid syntax from the "Mermaid" tab.')}</p>
              <button
                onClick={() => setActiveTab("code")}
                className="px-3 py-1.5 bg-warn text-warn-fg rounded-lg text-xs font-medium hover:brightness-110"
              >
                {t("View the syntax")}
              </button>
            </div>
          ) : (
            <div
              ref={containerRef}
              // CSS zoom, bukan transform: scale() — transform tidak mengubah
              // kotak layout, sehingga elemen tetap memesan tinggi ukuran asli
              // dan meninggalkan ruang kosong besar di bawah diagram saat
              // diperkecil. m-auto memusatkan tanpa memotong diagram yang besar.
              style={{ zoom }}
              className="m-auto p-4"
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          )
        ) : (
          <div className="w-full h-full bg-code text-code-ink font-mono text-xs p-4 rounded-lg overflow-auto leading-relaxed">
            <pre>{chart}</pre>
          </div>
        )}
      </div>

      {explanation && (
        <div className="p-4 bg-subtle border-t border-line text-muted leading-relaxed">
          <strong className="text-ink font-medium block mb-1">{t("How the flow works")}</strong>
          {explanation}
        </div>
      )}
    </div>
  );

  return isFullscreen ? createPortal(viewer, document.body) : viewer;
};
