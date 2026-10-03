import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, DraftingCompass, Folder, FolderKanban, ListTree, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Search, Trash2, X } from "lucide-react";
import type { ProjectSession, SessionSummary } from "../types";
import { projectNameFromWorkspaceRoot } from "../lib/workspace";
import { folderProject } from "../lib/workspaceProject";
import { LogoMark } from "./LogoMark";
import { useT } from "../lib/i18n";
import { useDismissable } from "../lib/dismissable";

type ChatSort = "recent" | "name";

interface SidebarProps {
  session: ProjectSession;
  historySessions: SessionSummary[];
  onNewProject: () => void;
  onSelectHistorySession: (id: string) => void;
  onOpenChatStep: (id: string, step: 1 | 2 | 3) => void;
  onDeleteHistory: (id: string) => void;
  isOpen: boolean;
  onClose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectAgent?: () => void;
  /** The chat open in the open project. */
  activeChatId: string | null;
  onOpenChat: (projectId: string, conversationId: string) => void;
  onNewChatInFolder: (projectId: string) => void;
  onDeleteChat: (projectId: string, conversationId: string) => void;
}

interface ChatGroup {
  key: string;
  name: string;
  chats: SessionSummary[];
  latest: number;
}

const DAY_MS = 86_400_000;

// Group headers carry their own last activity, which is what explains the
// order. Anything inside the last week reads better as an age than as a date.
function activityLabel(iso: string, lang: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const elapsed = Date.now() - then.getTime();
  if (elapsed < 3_600_000) return `${Math.max(1, Math.round(elapsed / 60_000))}m`;
  if (elapsed < DAY_MS) return `${Math.round(elapsed / 3_600_000)}h`;
  if (elapsed < 7 * DAY_MS) return `${Math.round(elapsed / DAY_MS)}d`;
  return then.toLocaleDateString(lang, { month: "numeric", day: "2-digit" });
}

function groupChats(sessions: SessionSummary[], sort: ChatSort, unfiledName: string): ChatGroup[] {
  const groups = new Map<string, ChatGroup>();
  for (const chat of sessions) {
    const key = chat.workspaceRoot?.trim() || "";
    const existing = groups.get(key);
    const at = new Date(chat.updatedAt).getTime() || 0;
    if (existing) {
      existing.chats.push(chat);
      existing.latest = Math.max(existing.latest, at);
    } else {
      groups.set(key, {
        key,
        name: key ? projectNameFromWorkspaceRoot(key) || key : unfiledName,
        chats: [chat],
        latest: at,
      });
    }
  }

  const byChat = sort === "name"
    ? (a: SessionSummary, b: SessionSummary) => a.title.localeCompare(b.title)
    : (a: SessionSummary, b: SessionSummary) => (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0);

  return [...groups.values()]
    .map((group) => ({ ...group, chats: [...group.chats].sort(byChat) }))
    .sort((a, b) => {
      // Chats without a folder are the leftovers, so they stay at the bottom
      // whichever way the rest is sorted.
      if (!a.key !== !b.key) return a.key ? -1 : 1;
      return sort === "name" ? a.name.localeCompare(b.name) : b.latest - a.latest;
    });
}

export const Sidebar: React.FC<SidebarProps> = ({
  session,
  historySessions,
  onNewProject,
  onSelectHistorySession,
  onOpenChatStep,
  onDeleteHistory,
  isOpen,
  onClose,
  collapsed,
  onToggleCollapsed,
  onSelectAgent,
  activeChatId,
  onOpenChat,
  onNewChatInFolder,
  onDeleteChat,
}) => {
  const { lang, t } = useT();
  const [sort, setSort] = useState<ChatSort>("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const sortTrigger = useRef<HTMLButtonElement | null>(null);
  const sortRef = useDismissable<HTMLDivElement>((reason) => {
    setSortOpen((open) => {
      if (open && reason === "escape") sortTrigger.current?.focus();
      return false;
    });
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  // A chat the user opened or closed by hand stays that way; the rest follow
  // the default: the open chat shows its steps once it has a plan.
  const [chatOpen, setChatOpen] = useState<Record<string, boolean>>({});

  const isRail = collapsed && !isOpen;
  const search = query.trim().toLowerCase();
  const closeButton = useRef<HTMLButtonElement>(null);

  // Di ponsel sidebar menutupi halaman seperti dialog, jadi ia berperilaku
  // seperti dialog: fokus masuk ke tombol tutup, Escape menutup, dan fokus
  // kembali ke tombol yang membukanya. Escape diserahkan lebih dulu ke menu
  // urutan kalau menu itu yang sedang terbuka.
  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButton.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sortOpen) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [isOpen, sortOpen, onClose]);

  const groups = useMemo(() => {
    const matching = search
      ? historySessions.filter((chat) => (chat.title || "").toLowerCase().includes(search)
        || (chat.chats ?? []).some((item) => item.title.toLowerCase().includes(search)))
      : historySessions;
    return groupChats(matching, sort, t("No folder"));
  }, [historySessions, search, sort, t]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleChat = (id: string, expanded: boolean) => {
    setChatOpen((prev) => ({ ...prev, [id]: !expanded }));
  };

  const openChat = (id: string) => {
    onSelectHistorySession(id);
    onClose();
  };

  const openStep = (id: string, step: 1 | 2 | 3) => {
    onOpenChatStep(id, step);
    onClose();
  };

  const startNewChat = () => {
    onNewProject();
    onSelectAgent?.();
    onClose();
  };

  // Plan, PRD and Kanban of one project.
  const stepRows = (chat: SessionSummary, isActive: boolean, indent: string) => {
    const activeStep = isActive ? session.currentStep : 0;
    return (
      <div className={`space-y-px py-0.5 ${indent}`}>
        <button type="button" onClick={() => openStep(chat.id, 1)} className={`shell-step ${activeStep === 1 ? "is-active" : ""}`}>
          <ListTree className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="flex-1 truncate">{t("Plan")}</span>
        </button>
        <button type="button" onClick={() => openStep(chat.id, 2)} className={`shell-step ${activeStep === 2 ? "is-active" : ""}`}>
          <DraftingCompass className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="flex-1 truncate">{t("PRD")}</span>
        </button>
        <button
          type="button"
          onClick={() => openStep(chat.id, 3)}
          aria-label={chat.taskCount ? undefined : `${t("Kanban")} — ${t("empty")}`}
          className={`shell-step ${activeStep === 3 ? "is-active" : ""}`}
        >
          <FolderKanban className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="flex-1 truncate">{t("Kanban")}</span>
          {!chat.taskCount && <span className="shrink-0 text-[10px] text-faint">{t("empty")}</span>}
          {isActive && Boolean(session.tasks?.length) && (
            <span className="shrink-0 text-[10px] tabular-nums text-faint">
              {session.tasks!.filter((task) => task.status === "done").length}/{session.tasks!.length}
            </span>
          )}
        </button>
      </div>
    );
  };

  // A project with its own Plan, PRD and Kanban under its one chat: a chat
  // without a folder, or an older project saved in a folder that has another.
  const sessionRow = (chat: SessionSummary) => {
    const isActive = chat.id === session.id;
    const isExpanded = chatOpen[chat.id] ?? (isActive && chat.hasPlan);
    return (
      <div key={chat.id}>
        <div className={`shell-history-row group ${isActive ? "is-active" : ""}`}>
          {chat.hasPlan ? (
            <button
              type="button"
              onClick={() => toggleChat(chat.id, isExpanded)}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? t("Collapse chat") : t("Expand chat")}
              className="flex h-[30px] w-5 shrink-0 items-center justify-center text-faint hover:text-ink"
            >
              <ChevronDown className={`h-3 w-3 transition-transform ${isExpanded ? "" : "-rotate-90"}`} aria-hidden />
            </button>
          ) : (
            <span className="h-[30px] w-5 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            onClick={() => openChat(chat.id)}
            aria-current={isActive ? "page" : undefined}
            aria-label={`${chat.title || t("Untitled project")} — ${activityLabel(chat.updatedAt, lang)}`}
            className="flex min-w-0 flex-1 items-center gap-2 py-[7px] pr-1 text-left"
          >
            <span className="min-w-0 flex-1 truncate text-[12px]">{chat.title || t("Untitled project")}</span>
            <span className="shrink-0 text-[10px] text-faint">{activityLabel(chat.updatedAt, lang)}</span>
          </button>
          <button
            type="button"
            onClick={() => onDeleteHistory(chat.id)}
            title={t("Remove from history")}
            className="mr-1 rounded p-1 text-transparent group-hover:text-faint hover:!text-danger focus-visible:text-faint"
            aria-label={t("Remove from history")}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        {chat.hasPlan && isExpanded && stepRows(chat, isActive, "pl-5")}
      </div>
    );
  };

  // A folder's project: its Plan, PRD and Kanban once, then every chat that shares them.
  const folderProjectRows = (owner: SessionSummary) => {
    const isActive = owner.id === session.id;
    const chats = (owner.chats ?? []).filter((chat) => !search || chat.title.toLowerCase().includes(search) || owner.title.toLowerCase().includes(search));
    // A chat just opened has no messages yet, so the server does not list it.
    const openNew = isActive && activeChatId && !chats.some((chat) => chat.id === activeChatId);
    return (
      <>
        {stepRows(owner, isActive, "pl-1")}
        {openNew && (
          <div className="shell-history-row is-active">
            <MessageSquare className="ml-1.5 mr-1 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate py-[7px] text-[12px]">{t("New chat")}</span>
          </div>
        )}
        {chats.map((chat) => {
          const isOpen = isActive && chat.id === activeChatId;
          return (
            <div key={chat.id} className={`shell-history-row group ${isOpen ? "is-active" : ""}`}>
              <button
                type="button"
                onClick={() => { onOpenChat(owner.id, chat.id); onClose(); }}
                aria-current={isOpen ? "page" : undefined}
                aria-label={`${chat.title || t("New chat")} — ${activityLabel(chat.updatedAt, lang)}`}
                className="flex min-w-0 flex-1 items-center gap-1 py-[7px] pr-1 text-left"
              >
                <MessageSquare className="ml-1.5 mr-1 h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[12px]">{chat.title || t("New chat")}</span>
                <span className="shrink-0 text-[10px] text-faint">{activityLabel(chat.updatedAt, lang)}</span>
              </button>
              <button
                type="button"
                onClick={() => onDeleteChat(owner.id, chat.id)}
                title={t("Delete this chat")}
                className="mr-1 rounded p-1 text-transparent group-hover:text-faint hover:!text-danger focus-visible:text-faint"
                aria-label={t("Delete this chat")}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </>
    );
  };

  return (
    <>
      {isOpen && <div onClick={onClose} className="fixed inset-0 z-40 bg-black/40 md:hidden" aria-hidden />}
      {/* Off screen is not enough: the closed drawer's links stayed in the Tab
          order. Hiding waits for the slide-out; showing is immediate so the
          close button can take focus as the drawer opens. */}
      <aside
        className={`shell-sidebar fixed inset-y-0 left-0 z-50 flex h-screen shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar duration-200 md:sticky md:top-0 md:translate-x-0 ${isRail ? "w-14" : "w-[15.5rem]"} ${isOpen ? "translate-x-0 transition-[transform,width]" : "-translate-x-full transition-[transform,width,visibility] max-md:invisible"}`}
        aria-label={t("Main navigation")}
      >
        <div className={`flex shrink-0 items-center gap-2 py-3 ${isRail ? "justify-center px-0" : "px-3"}`}>
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent text-accent-fg">
            <LogoMark className="h-5 w-5" />
          </span>
          {!isRail && <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink">Undagi</span>}
          {!isRail && (
            <button type="button" ref={closeButton} onClick={onClose} className="rounded-md p-1.5 text-faint hover:bg-subtle hover:text-ink md:hidden" aria-label={t("Close menu")}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
          {!isOpen && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              className={`rounded-md p-1.5 text-faint hover:bg-subtle hover:text-ink ${isRail ? "hidden" : "hidden md:block"}`}
              aria-label={t("Collapse sidebar")}
            >
              <PanelLeftClose className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>

        <div className={`shrink-0 pb-2 ${isRail ? "px-2" : "px-2.5"}`}>
          <button type="button" onClick={startNewChat} title={t("New chat")} className={`shell-new-chat ${isRail ? "mx-auto h-9 w-9 justify-center px-0" : "w-full justify-center px-2"}`}>
            <Plus className="h-4 w-4 shrink-0" aria-hidden />
            {!isRail && <span>{t("New chat")}</span>}
          </button>
        </div>

        {isRail ? (
          <div className="mt-auto shrink-0 px-2 pb-3">
            <button type="button" onClick={onToggleCollapsed} className="shell-settings-button mx-auto" aria-label={t("Expand sidebar")}>
              <PanelLeftOpen className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2.5 pb-3">
            <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
              <span className="flex-1 text-[11px] font-semibold text-faint">{t("Chats")}</span>
              <div ref={sortRef} className="relative">
                <button
                  type="button"
                  ref={sortTrigger}
                  onClick={() => setSortOpen((open) => !open)}
                  aria-expanded={sortOpen}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted hover:bg-subtle hover:text-ink"
                >
                  {sort === "recent" ? t("Recent") : t("Name")}
                  <ChevronDown className="h-3 w-3" aria-hidden />
                </button>
                {sortOpen && (
                  <div className="absolute right-0 top-full z-10 mt-1 w-32 rounded-lg border border-line bg-surface p-1 shadow-elev-2">
                    {([["recent", t("Recent")], ["name", t("Name")]] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => { setSort(value); setSortOpen(false); sortTrigger.current?.focus(); }}
                        aria-pressed={sort === value}
                        className={`block w-full rounded px-2 py-1.5 text-left text-[11px] ${sort === value ? "bg-accent-soft text-accent-ink" : "text-muted hover:bg-subtle hover:text-ink"}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => { setSearchOpen((open) => !open); if (searchOpen) setQuery(""); }}
                aria-expanded={searchOpen}
                className="rounded p-1 text-faint hover:bg-subtle hover:text-ink"
                aria-label={t("Search chats")}
              >
                <Search className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            {searchOpen && (
              <div className="shrink-0 px-1 pb-2">
                <label htmlFor="sidebar-search" className="sr-only">{t("Search chats")}</label>
                <input
                  id="sidebar-search"
                  type="search"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); setSearchOpen(false); } }}
                  placeholder={t("Search chats")}
                  className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-ink outline-none placeholder:text-faint focus:border-accent"
                />
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              {groups.length === 0 && (
                <p className="px-2 pt-2 text-[11px] leading-relaxed text-faint">
                  {search ? t("No chat matches that search.") : t("No chats yet")}
                </p>
              )}

              {groups.map((group) => {
                const isCollapsed = collapsedGroups.has(group.key) && !search;
                // A folder's chats share one project; any other project saved in the
                // same folder before stays listed as it was.
                const owner = group.key ? folderProject(group.chats) : null;
                const others = group.chats.filter((chat) => chat.id !== owner?.id);
                return (
                  <div key={group.key || "unfiled"} className="group/folder mt-2 first:mt-0">
                    <div className="flex items-center rounded-md hover:bg-subtle">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.key)}
                        aria-expanded={!isCollapsed}
                        aria-label={`${group.name} — ${activityLabel(new Date(group.latest).toISOString(), lang)}`}
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                      >
                        <ChevronDown className={`h-3 w-3 shrink-0 text-faint transition-transform ${isCollapsed ? "-rotate-90" : ""}`} aria-hidden />
                        <Folder className={`h-3.5 w-3.5 shrink-0 ${group.key ? "text-accent-ink" : "text-faint"}`} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-ink">{group.name}</span>
                        <span className="shrink-0 text-[10px] text-faint">{activityLabel(new Date(group.latest).toISOString(), lang)}</span>
                      </button>
                      {owner && (
                        <>
                          <button
                            type="button"
                            onClick={() => { onNewChatInFolder(owner.id); onClose(); }}
                            title={t("New chat in this folder")}
                            aria-label={t("New chat in this folder")}
                            className="rounded p-1 text-transparent group-hover/folder:text-faint hover:!text-ink focus-visible:text-faint"
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => { if (window.confirm(t("Remove this folder's project from history? Its plan, PRD, board, memory and chats are deleted; the files in the folder stay."))) onDeleteHistory(owner.id); }}
                            title={t("Remove project from history")}
                            aria-label={t("Remove project from history")}
                            className="mr-1 rounded p-1 text-transparent group-hover/folder:text-faint hover:!text-danger focus-visible:text-faint"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        </>
                      )}
                    </div>

                    {!isCollapsed && (
                      <div className="space-y-px pl-3">
                        {owner && folderProjectRows(owner)}
                        {others.map(sessionRow)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </aside>
    </>
  );
};

export default Sidebar;
