// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import React, { useLayoutEffect, useRef, useState } from "react";
import { ProjectSession } from "../types";
import { Bug, Check, Download, Layers, Menu, MessageSquare, Moon, Plug, Settings2, Sun } from "lucide-react";
import { useT, type Language } from "../lib/i18n";
import { useConnections } from "../lib/connections";
import { useDismissable } from "../lib/dismissable";
import { SAMPLE_PROJECTS, sampleText, type SampleProject } from "../lib/sampleData";
import { ACCENTS, type Accent, type Theme } from "../lib/theme";
import { CoffeeIcon } from "./CoffeeIcon";

export type LayoutMode = "agent" | "split" | "board";

export interface TopbarProps {
  session: ProjectSession;
  onOpenMenu: () => void;
  onOpenExport: () => void;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  layoutMode?: LayoutMode;
  onLayoutModeChange?: (mode: LayoutMode) => void;
  isNarrow?: boolean;
  onOpenConnections: () => void;
  onOpenSettings: () => void;
  onOpenBugReport: () => void;
  onOpenDonate: () => void;
  onSelectSample: (sample: SampleProject) => void;
  theme: Theme;
  onToggleTheme: () => void;
  accent: Accent;
  onSelectAccent: (accent: Accent) => void;
  onSelectLanguage: (lang: Language) => void;
}

const LANGUAGE_NAMES: Record<Language, string> = { en: "English", id: "Bahasa Indonesia" };

// Contoh warna di pemilih memakai nilai mode terang; nilai sebenarnya ada di
// index.css. Tinta mengikuti warna teks, jadi contohnya pun ikut berbalik.
const ACCENT_SWATCHES: Record<Accent, { name: string; color: string }> = {
  teal: { name: "Teal", color: "#0f766e" },
  blue: { name: "Blue", color: "#2563eb" },
  violet: { name: "Violet", color: "#7c3aed" },
  pink: { name: "Pink", color: "#be185d" },
  moss: { name: "Moss", color: "#3f6212" },
  ink: { name: "Ink", color: "var(--app-ink)" },
};

export const Topbar: React.FC<TopbarProps> = ({
  session,
  onOpenMenu,
  onOpenExport,
  chatOpen,
  onToggleChat,
  layoutMode = "agent",
  onLayoutModeChange,
  isNarrow = false,
  onOpenConnections,
  onOpenSettings,
  onOpenBugReport,
  onOpenDonate,
  onSelectSample,
  theme,
  onToggleTheme,
  accent,
  onSelectAccent,
  onSelectLanguage,
}) => {
  const { lang, t } = useT();
  const { connections } = useConnections();
  const [openMenu, setOpenMenu] = useState<"settings" | null>(null);
  // Tombol yang membuka menu, supaya Escape mengembalikan fokus ke sana.
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const menuRef = useDismissable<HTMLDivElement>((reason) => {
    setOpenMenu((open) => {
      if (open && reason === "escape") menuTrigger.current?.focus();
      return null;
    });
  });

  // Each menu hangs off its button's right edge. On a phone the header wraps
  // and the buttons sit near the left, so that pushed the menu off screen.
  const menuPopup = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const popup = menuPopup.current;
    if (!popup) return;
    popup.style.translate = "";
    const margin = 8;
    const rect = popup.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const shift = rect.left < margin
      ? margin - rect.left
      : rect.right > viewport - margin ? viewport - margin - rect.right : 0;
    if (shift) popup.style.translate = `${shift}px 0`;
  }, [openMenu]);

  const toggleMenu = (menu: "settings", trigger: HTMLButtonElement) => {
    menuTrigger.current = trigger;
    setOpenMenu((open) => (open === menu ? null : menu));
  };

  const hasArtifacts = Boolean(session.plan || session.prd || session.tasks);
  const activeConnections = connections.filter((connection) => connection.enabled).length;
  const layoutModes: { id: LayoutMode; label: string }[] = [
    { id: "agent", label: t("Chat") },
    ...(!isNarrow ? [{ id: "split" as const, label: t("Split") }] : []),
    { id: "board", label: t("Board") },
  ];

  return (
    <header className="shell-topbar sticky top-0 z-30 shrink-0 border-b border-line bg-surface">
      {/* The layout switcher leads on the left, where the project's place used to
          be: the sidebar already shows the folder and the open chat. On a phone
          the controls wrap under it instead of being cut off. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 sm:min-h-[3.25rem] sm:flex-nowrap sm:gap-2.5 sm:py-0 md:px-4">
        <button
          onClick={onOpenMenu}
          className="-ml-1 shrink-0 rounded-lg p-2 text-muted hover:bg-subtle hover:text-ink md:hidden"
          aria-label={t("Open menu")}
        >
          <Menu className="h-4 w-4" aria-hidden />
        </button>

        {onLayoutModeChange && (
          <div
            role="group"
            aria-label={t("Layout mode")}
            className="shell-layout-switcher flex shrink-0 items-center gap-0.5 rounded-lg bg-subtle p-0.5 text-[12px] font-medium"
          >
            {layoutModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                onClick={() => onLayoutModeChange(mode.id)}
                aria-pressed={layoutMode === mode.id}
                className={`rounded-md px-2.5 py-1 transition-colors ${
                  // In dark mode the surface is darker than this group's background,
                  // so the selected mode takes the app's accent instead.
                  layoutMode === mode.id
                    ? "bg-accent-soft font-semibold text-accent-ink ring-1 ring-inset ring-accent/40"
                    : "text-muted hover:text-ink"
                }`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        )}

        <span className="flex-1" />

        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5 sm:flex-nowrap sm:gap-2.5">
        {hasArtifacts && (
          <button onClick={onOpenExport} className="shell-icon-button" title={t("Export document & task bundle")}>
            <Download className="h-4 w-4 text-faint" aria-hidden />
            <span className="hidden lg:inline">{t("Export")}</span>
          </button>
        )}

        {onToggleChat && (
          <button
            onClick={onToggleChat}
            className="shell-icon-button"
            aria-pressed={Boolean(chatOpen)}
            title={t("Ask the agent to change this project")}
          >
            <MessageSquare className="h-4 w-4 text-faint" aria-hidden />
            <span className="hidden lg:inline">{t("Agent")}</span>
          </button>
        )}

        <div ref={menuRef} className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleTheme}
            className="shell-settings-button"
            title={theme === "dark" ? t("Light mode") : t("Dark mode")}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
            <span className="sr-only">{theme === "dark" ? t("Light mode") : t("Dark mode")}</span>
          </button>

          <button type="button" onClick={onOpenConnections} className="shell-icon-button" title={t("Connections")}>
            <Plug className="h-4 w-4 text-faint" aria-hidden />
            <span className="hidden lg:inline">{t("Connections")}</span>
            {activeConnections > 0 && (
              <span className="rounded bg-ok-soft px-1.5 text-[10px] font-semibold text-ok-ink">{activeConnections}</span>
            )}
          </button>

          <button type="button" onClick={onOpenDonate} className="shell-settings-button" title={t("Support Undagi")}>
            <CoffeeIcon />
            <span className="sr-only">{t("Support Undagi")}</span>
          </button>

          <button type="button" onClick={onOpenBugReport} className="shell-settings-button" title={t("Report a bug")}>
            <Bug className="h-4 w-4" aria-hidden />
            <span className="sr-only">{t("Report a bug")}</span>
          </button>

          {/* Bahasa, tema, dan pengaturan agent jarang diubah, jadi ketiganya
              dikumpulkan di satu menu supaya topbar hanya memuat kerja harian. */}
          <div className="relative">
            <button
              type="button"
              onClick={(event) => toggleMenu("settings", event.currentTarget)}
              aria-expanded={openMenu === "settings"}
              className="shell-settings-button"
              title={t("Settings")}
            >
              <Settings2 className="h-4 w-4" aria-hidden />
              <span className="sr-only">{t("Settings")}</span>
            </button>
            {openMenu === "settings" && (
              <div ref={menuPopup} className="absolute right-0 top-full z-40 mt-1.5 w-56 rounded-lg border border-line bg-surface p-1 shadow-elev-2">
                <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint">{t("Language")}</p>
                {(["en", "id"] as const).map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => { onSelectLanguage(code); setOpenMenu(null); }}
                    aria-pressed={lang === code}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] ${lang === code ? "bg-accent-soft font-semibold text-accent-ink" : "text-muted hover:bg-subtle hover:text-ink"}`}
                  >
                    <span className="flex-1">{LANGUAGE_NAMES[code]}</span>
                    {lang === code && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                  </button>
                ))}
                <div className="my-1 h-px bg-line" aria-hidden />
                <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint">{t("Accent colour")}</p>
                <div className="flex items-center gap-1.5 px-2 pb-1.5">
                  {ACCENTS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => onSelectAccent(option)}
                      aria-pressed={accent === option}
                      aria-label={t(ACCENT_SWATCHES[option].name)}
                      title={t(ACCENT_SWATCHES[option].name)}
                      className={`grid h-7 w-7 place-items-center rounded-full ring-offset-2 ring-offset-surface ${accent === option ? "ring-2 ring-strong" : "hover:ring-2 hover:ring-line"}`}
                    >
                      <span className="h-5 w-5 rounded-full border border-white/20" style={{ backgroundColor: ACCENT_SWATCHES[option].color }} />
                    </button>
                  ))}
                </div>
                <div className="my-1 h-px bg-line" aria-hidden />
                <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint">{t("Templates")}</p>
                {SAMPLE_PROJECTS.map((sample) => (
                  <button
                    key={sample.id}
                    type="button"
                    onClick={() => { onSelectSample(sample); setOpenMenu(null); }}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] text-muted hover:bg-subtle hover:text-ink"
                    title={sampleText(sample, lang).tagline}
                  >
                    <Layers className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{sampleText(sample, lang).name}</span>
                  </button>
                ))}
                <div className="my-1 h-px bg-line" aria-hidden />
                <button
                  type="button"
                  // Dialog mengembalikan fokus ke elemen yang fokus saat ia dibuka;
                  // item menu ini langsung hilang, jadi fokus dipindah dulu ke tombolnya.
                  onClick={() => { setOpenMenu(null); menuTrigger.current?.focus(); onOpenSettings(); }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12px] text-muted hover:bg-subtle hover:text-ink"
                >
                  <Settings2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="flex-1">{t("Agent settings")}</span>
                </button>
                <div className="my-1 h-px bg-line" aria-hidden />
                <p className="px-2 py-1.5 text-[11px] text-faint">Undagi v{__APP_VERSION__}</p>
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    </header>
  );
};
