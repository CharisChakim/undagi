// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useRef } from "react";

export interface SplitterProps {
  ratio: number;
  onRatioChange: (ratio: number) => void;
  onCommit?: (ratio: number) => void;
}

const clamp = (value: number): number => Math.min(0.75, Math.max(0.25, value));

export const Splitter: React.FC<SplitterProps> = ({ ratio, onRatioChange, onCommit }) => {
  const dragging = useRef(false);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const updateFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const parent = event.currentTarget.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (!rect.width) return;

    const next = clamp((event.clientX - rect.left) / rect.width);
    ratioRef.current = next;
    onRatioChange(next);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragging.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) updateFromPointer(event);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onCommit?.(ratioRef.current);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -0.02 : 0.02;
    const next = clamp(ratioRef.current + delta);
    ratioRef.current = next;
    onRatioChange(next);
    onCommit?.(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(ratio * 100)}
      aria-label="Resize panels"
      tabIndex={0}
      className="group relative z-10 flex w-3 shrink-0 cursor-col-resize touch-none items-stretch justify-center bg-canvas focus:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onKeyDown={handleKeyDown}
    >
      <span className="w-px bg-line transition-colors group-hover:bg-accent group-focus:bg-accent" />
      <span className="absolute inset-y-0 flex w-5 items-center justify-center">
        <span className="h-8 w-1 rounded-full bg-strong transition-colors group-hover:bg-accent group-focus:bg-accent" />
      </span>
    </div>
  );
};

