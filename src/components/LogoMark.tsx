// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React from "react";

// Simpul Undagi: tiga task yang terhubung membentuk huruf U. Simpul kanan
// berongga — task yang belum selesai. Garis siku dan simpul kotak sengaja:
// versi bulat terbaca sebagai stetoskop. Digambar dengan currentColor supaya
// mengikuti warna aksen yang dipilih pengguna. Sumber ikon aplikasi yang sama
// ada di build-resources/icon.svg.
export const LogoMark: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 100 100" className={className} fill="currentColor" aria-hidden>
    <path d="M30 25V73H70V35" fill="none" stroke="currentColor" strokeWidth="8" strokeLinejoin="round" />
    <rect x="20" y="15" width="20" height="20" rx="5" />
    <rect x="40" y="63" width="20" height="20" rx="5" />
    <rect x="61.5" y="16.5" width="17" height="17" rx="4" fill="none" stroke="currentColor" strokeWidth="5" />
  </svg>
);

export default LogoMark;
