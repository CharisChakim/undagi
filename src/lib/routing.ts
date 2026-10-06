// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { ProjectSession } from "../types";

export type Step = 1 | 2 | 3;

export const AGENT_PATH = "/";

// Satu path per langkah. Sengaja tidak memuat id proyek: proyek yang sedang
// dibuka sudah diingat di localStorage, dan menaruhnya di URL berarti setiap
// tautan yang dibagikan menunjuk sesi yang hanya ada di mesin pengirimnya.
export const STEP_PATHS: Record<Step, string> = {
  1: "/plan",
  2: "/prd",
  3: "/tasks",
};

export const pathToStep = (pathname: string): Step | null => {
  const entry = (Object.entries(STEP_PATHS) as [string, string][]).find(([, p]) => p === pathname);
  return entry ? (Number(entry[0]) as Step) : null;
};

// Setiap workspace bisa dimulai dari Plan, PRD, atau Kanban. Ketergantungan
// berlaku pada aksi di dalam langkah (misalnya generate task memerlukan PRD),
// bukan pada navigasinya.
export const isStepReachable = (step: Step, session: ProjectSession): boolean => {
  // PRD can start directly from the project brief; a Plan improves its input
  // but is not a prerequisite.
  if (step === 2) return true;
  if (step === 3) return true;
  return true;
};
