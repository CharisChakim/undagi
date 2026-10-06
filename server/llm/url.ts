// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

const VERSIONED = /\/v\d[\w.-]*(\/|$)/;

// Versi endpoint bisa memiliki nama tambahan seperti v1beta/openai, jadi pencarian
// versi harus dilakukan di seluruh path agar /v1/v1/... tidak pernah terbentuk.
export function apiUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (root.endsWith("/" + suffix)) return root;
  return VERSIONED.test(root) ? `${root}/${suffix}` : `${root}/v1/${suffix}`;
}
