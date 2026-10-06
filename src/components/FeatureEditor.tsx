// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React from "react";
import { Plus, Trash2, X } from "lucide-react";
import { FeatureSpec } from "../types";
import { useT } from "../lib/i18n";

// Bukan kelas .field global: yang itu memaksa w-full, sedangkan di sini isian
// dipakai sebagai flex item yang lebarnya ditentukan pemakainya.
const field =
  "px-3 py-2 bg-surface border border-strong rounded-lg text-sm text-ink " +
  "placeholder:text-faint focus:outline-hidden focus:ring-2 focus:ring-accent focus:border-accent";

const PRIORITY_LABELS: { value: FeatureSpec["priority"]; label: string }[] = [
  { value: "P0", label: "P0 · MVP" },
  { value: "P1", label: "P1 · Important" },
  { value: "P2", label: "P2 · Later" },
];

interface FeatureEditorProps {
  features: FeatureSpec[];
  onChange: (features: FeatureSpec[]) => void;
}

export const FeatureEditor: React.FC<FeatureEditorProps> = ({ features, onChange }) => {
  const { t } = useT();
  const patch = (idx: number, changes: Partial<FeatureSpec>) =>
    onChange(features.map((f, i) => (i === idx ? { ...f, ...changes } : f)));

  return (
    <div className="card p-5 space-y-3">
      {features.map((feature, idx) => {
        const subs = feature.subFeatures || [];
        const setSubs = (next: string[]) => patch(idx, { subFeatures: next });

        return (
          <div key={idx} className="rounded-lg border border-line p-4 space-y-3">
            <div className="flex items-start gap-2">
              <input
                value={feature.name}
                onChange={(e) => patch(idx, { name: e.target.value })}
                placeholder={t("Feature name")}
                className={`${field} flex-1 min-w-0 font-medium`}
              />
              <select
                value={feature.priority}
                onChange={(e) => patch(idx, { priority: e.target.value as FeatureSpec["priority"] })}
                className={`${field} shrink-0`}
              >
                {PRIORITY_LABELS.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
              <button
                onClick={() => onChange(features.filter((_, i) => i !== idx))}
                title={t("Delete feature")}
                className="p-2 shrink-0 text-faint hover:text-danger rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <textarea
              rows={2}
              value={feature.description}
              onChange={(e) => patch(idx, { description: e.target.value })}
              placeholder={t("Feature description")}
              className={`${field} w-full leading-relaxed resize-y`}
            />

            <div className="space-y-2">
              <span className="block text-xs font-medium text-faint">{t("Sub features")}</span>

              {subs.map((sub, sIdx) => (
                <div key={sIdx} className="flex items-center gap-2">
                  <input
                    value={sub}
                    onChange={(e) => setSubs(subs.map((s, i) => (i === sIdx ? e.target.value : s)))}
                    placeholder={t("e.g. Candlestick view")}
                    className={`${field} flex-1 min-w-0 text-xs`}
                  />
                  <button
                    onClick={() => setSubs(subs.filter((_, i) => i !== sIdx))}
                    title={t("Delete sub feature")}
                    className="p-1.5 shrink-0 text-faint hover:text-danger rounded-lg transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}

              <button
                onClick={() => setSubs([...subs, ""])}
                className="flex items-center gap-1.5 text-xs text-faint hover:text-ink transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> {t("Add sub feature")}
              </button>
            </div>
          </div>
        );
      })}

      <button
        onClick={() => onChange([...features, { name: "", description: "", priority: "P1", subFeatures: [] }])}
        className="btn-primary"
      >
        <Plus className="w-4 h-4" /> {t("Add feature")}
      </button>
    </div>
  );
};
