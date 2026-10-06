// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useEffect, useRef } from "react";
import { ExternalLink, X } from "lucide-react";
import { useT } from "../lib/i18n";
import { PAYPAL_ME_URL, QRIS_IMAGE } from "../lib/donate";
import { CoffeeIcon } from "./CoffeeIcon";

interface DonateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const DonateModal: React.FC<DonateModalProps> = ({ isOpen, onClose }) => {
  const { t } = useT();
  const closeButton = useRef<HTMLButtonElement>(null);

  // Same as the other dialogs: focus goes in, Escape closes, focus goes back.
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="donate-title"
        className="card shadow-elev-3 w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-2.5">
            <CoffeeIcon />
            <h3 id="donate-title" className="font-semibold text-ink">{t("Support Undagi")}</h3>
          </div>
          <button ref={closeButton} type="button" onClick={onClose} className="rounded-lg p-1.5 text-faint transition-colors hover:bg-subtle hover:text-ink" aria-label={t("Close")}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="space-y-5 p-6">
          <p className="leading-relaxed text-muted">
            {t("Undagi is free and open source. If it helps your work, a coffee for its maker keeps it going. Thank you!")}
          </p>

          <section aria-labelledby="donate-qris" className="space-y-2">
            <h4 id="donate-qris" className="text-sm font-semibold text-ink">{t("QRIS (Indonesia)")}</h4>
            <div className="flex items-center gap-4">
              {/* A QR code needs its white background to scan, in dark mode too. */}
              <img src={QRIS_IMAGE} alt={t("QRIS code for a donation")} width={160} height={160} className="h-40 w-40 shrink-0 rounded-lg border border-line bg-white p-1" />
              <p className="text-xs leading-relaxed text-muted">
                {t("Scan it with any bank or e-wallet app that supports QRIS, then enter the amount you like.")}
              </p>
            </div>
          </section>

          <section aria-labelledby="donate-paypal" className="space-y-2">
            <h4 id="donate-paypal" className="text-sm font-semibold text-ink">{t("PayPal (international)")}</h4>
            <p className="text-xs leading-relaxed text-muted">{t("Opens PayPal in your browser, where you choose the amount.")}</p>
            <a href={PAYPAL_ME_URL} target="_blank" rel="noopener noreferrer" className="btn-primary inline-flex">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              <span>{t("Donate with PayPal")}</span>
            </a>
          </section>
        </div>
      </div>
    </div>
  );
};

export default DonateModal;
