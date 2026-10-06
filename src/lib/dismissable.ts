// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { useEffect, useRef, type RefObject } from "react";

export type DismissReason = "escape" | "outside";

/**
 * Menutup popover saat Escape ditekan atau saat klik mendarat di luarnya.
 *
 * Alasannya diteruskan karena keduanya menuntut perlakuan berbeda pada fokus:
 * klik di luar sudah memindahkan fokus ke tempat yang dituju pengguna,
 * sedangkan Escape harus mengembalikannya ke tombol pembuka — kalau tidak,
 * fokus keyboard hilang ke awal halaman.
 */
export function useDismissable<T extends HTMLElement>(
  onDismiss: (reason: DismissReason) => void,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  const handler = useRef(onDismiss);
  handler.current = onDismiss;

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) handler.current("outside");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") handler.current("escape");
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return ref;
}
