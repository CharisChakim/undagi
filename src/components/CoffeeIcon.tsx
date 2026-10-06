// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React from "react";

// Cangkir kopi "traktir": badan terisi emas, gagang dan uap tetap garis supaya
// bentuknya terbaca, dengan lingkar cahaya lembut di belakangnya.
export const CoffeeIcon: React.FC = () => (
  <span className="coffee-halo" aria-hidden>
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 text-gold"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 2v2M10 2v2M14 2v2" />
      <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
      <path d="M3 9a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" fill="currentColor" />
    </svg>
  </span>
);
