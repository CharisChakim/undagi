// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

// Helper ini menjaga pembuatan unduhan browser tetap konsisten dan mencegah
// setiap komponen menyalin sendiri siklus Blob, link sementara, dan revoke URL.
export function downloadFile(filename: string, content: string, mime: string): void {
  downloadBlob(filename, new Blob([content], { type: `${mime};charset=utf-8` }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
