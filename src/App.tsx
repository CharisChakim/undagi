import React, { useState, useEffect, useRef, useMemo } from "react";
import { ProjectSession, SessionSummary, SessionUpdate } from "./types";
import {
  createEmptySession,
  loadSavedLLMConfig,
  loadActiveSessionId,
  saveActiveSessionId,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from "./lib/localStorage";
import { fetchSessionList, fetchSession, persistSession, removeChat, removeSession } from "./lib/sessionStore";
import { loadConversationId, newConversationId, saveConversationId } from "./lib/activeChat";
import { projectForFolder } from "./lib/workspaceProject";
import { Accent, Theme, applyAccent, loadAccent, loadTheme, saveAccent, saveTheme, applyTheme } from "./lib/theme";
import { Language, loadLanguage, saveLanguage, makeT, LanguageProvider } from "./lib/i18n";
import { AGENT_PATH, STEP_PATHS, pathToStep, isStepReachable, Step } from "./lib/routing";
import { LayoutMode, loadLayout, saveLayout } from "./lib/layout";
import { SampleProject, sampleText } from "./lib/sampleData";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Workbench } from "./components/shell/Workbench";
import { ConnectionsModal } from "./components/connections/ConnectionsModal";
import { ExportModal } from "./components/ExportModal";
import { BugReportModal } from "./components/BugReportModal";
import { DonateModal } from "./components/DonateModal";
import { RefreshCw } from "lucide-react";
import { projectNameFromWorkspaceRoot } from "./lib/workspace";
import {
  loadAgentHarnessSettings,
  saveAgentHarnessSettings,
  type AgentHarnessSettings,
} from "./lib/agentHarness";
import { AgentSettingsModal } from "./components/AgentSettingsModal";

export default function App() {
  const [session, setSession] = useState<ProjectSession | null>(null);
  const [historySessions, setHistorySessions] = useState<SessionSummary[]>([]);
  // Bumped when another chat of the open project is picked, so the chat pane reloads.
  const [chatKey, setChatKey] = useState(0);
  const [storeError, setStoreError] = useState<string | null>(null);

  const [isConnectionsModalOpen, setIsConnectionsModalOpen] = useState(false);
  const [connectionsInitialTab, setConnectionsInitialTab] = useState<"connections" | "runtimes">("connections");
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  const [isDonateOpen, setIsDonateOpen] = useState(false);
  const [isAgentSettingsOpen, setIsAgentSettingsOpen] = useState(false);
  const [agentHarnessSettings, setAgentHarnessSettings] = useState(loadAgentHarnessSettings);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [layout, setLayout] = useState(loadLayout);
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth <= 1100);
  const lastSingleMode = useRef<Exclude<LayoutMode, "split">>(layout.mode === "board" ? "board" : "agent");

  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [accent, setAccent] = useState<Accent>(loadAccent);
  const [lang, setLang] = useState<Language>(loadLanguage);

  // App ikut memakai t untuk teksnya sendiri, jadi fungsinya dibuat di sini dan
  // nilai yang sama diteruskan ke provider — sebuah komponen tidak bisa membaca
  // context yang ia sediakan sendiri.
  const t = useMemo(() => makeT(lang), [lang]);

  const toggleSidebarCollapsed = () => {
    setIsSidebarCollapsed((prev) => {
      saveSidebarCollapsed(!prev);
      return !prev;
    });
  };

  const selectLanguage = (next: Language) => {
    setLang(next);
    saveLanguage(next);
  };

  const updateAgentHarnessSettings = (settings: AgentHarnessSettings) => {
    setAgentHarnessSettings(settings);
    saveAgentHarnessSettings(settings);
  };

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    applyAccent(accent);
    saveAccent(accent);
  }, [accent]);

  // Dipakai pembaca layar untuk memilih pelafalan, dan browser untuk tawaran
  // terjemahan otomatis.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  // Snapshot of what the store already holds, so hydrating a session does not
  // immediately write it back (which would reorder history just by opening it).
  const lastPersistedRef = useRef<string | null>(null);

  // Sekali saja saat sesi pertama termuat: kalau URL menunjuk langkah lain dan
  // langkah itu memang boleh dibuka, URL yang menang — itu gunanya alamat bisa
  // disimpan. Setelah itu arahnya berbalik: URL yang mengikuti langkah aktif.
  const urlSynced = useRef(false);

  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth <= 1100);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (layout.mode !== "split") lastSingleMode.current = layout.mode;
  }, [layout.mode]);

  const effectiveLayoutMode: LayoutMode =
    isNarrow && layout.mode === "split" ? lastSingleMode.current : layout.mode;

  const handleLayoutModeChange = (mode: LayoutMode) => {
    if (isNarrow && mode === "split") mode = "board";
    if (mode !== "split") lastSingleMode.current = mode;
    const next = { ...layout, mode };
    setLayout(next);
    saveLayout(next);
  };

  const handleRatioChange = (ratio: number) => setLayout((previous) => ({ ...previous, ratio }));

  const handleRatioCommit = (ratio: number) => {
    const next = { ...layout, ratio };
    setLayout(next);
    saveLayout(next);
  };

  useEffect(() => {
    if (!session || urlSynced.current) return;
    urlSynced.current = true;

    const fromUrl = pathToStep(window.location.pathname);
    if (window.location.pathname === AGENT_PATH) {
      handleLayoutModeChange("agent");
    } else if (fromUrl && isStepReachable(fromUrl, session)) {
      if (fromUrl !== session.currentStep) handleUpdateSession({ currentStep: fromUrl });
      if (effectiveLayoutMode === "agent") handleLayoutModeChange(isNarrow ? "board" : "split");
    } else {
      const path = effectiveLayoutMode === "agent" ? AGENT_PATH : STEP_PATHS[session.currentStep];
      window.history.replaceState({}, "", path);
    }
  }, [session]);

  useEffect(() => {
    if (!session || !urlSynced.current) return;
    const path = effectiveLayoutMode === "agent" ? AGENT_PATH : STEP_PATHS[session.currentStep];
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
  }, [session?.currentStep, effectiveLayoutMode]);

  // Tombol back/forward browser. setSession dipakai langsung, bukan
  // handleUpdateSession, supaya sekadar menavigasi tidak menaikkan updatedAt
  // dan mengacak urutan riwayat.
  useEffect(() => {
    const handlePopState = () => {
      const step = pathToStep(window.location.pathname);
      if (!step) {
        if (window.location.pathname === AGENT_PATH) handleLayoutModeChange("agent");
        return;
      }
      setSession((prev) => (prev && isStepReachable(step, prev) ? { ...prev, currentStep: step } : prev));
      handleLayoutModeChange(isNarrow ? "board" : "split");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isNarrow]);

  const applySession = (next: ProjectSession, markAsPersisted: boolean) => {
    if (markAsPersisted) lastPersistedRef.current = JSON.stringify(next);
    setSession(next);
    saveActiveSessionId(next.id);
  };

  const refreshHistory = () =>
    fetchSessionList()
      .then(setHistorySessions)
      .catch((err: Error) => setStoreError(err.message));

  // Initial hydration: LLM config from localStorage, session content from SQLite.
  useEffect(() => {
    let cancelled = false;
    const llmConfig = loadSavedLLMConfig();
    const activeId = loadActiveSessionId();

    const hydrate = async () => {
      try {
        const list = await fetchSessionList();
        if (cancelled) return;
        setHistorySessions(list);

        const restored = activeId ? await fetchSession(activeId, llmConfig) : null;
        if (cancelled) return;
        // Keep an untitled draft's client identity across reloads. The server
        // still receives no persisted session for standalone chat; this ID
        // only lets its nullable conversation and local drafts be found again.
        const empty = createEmptySession(llmConfig);
        if (!restored && activeId) empty.id = activeId;
        applySession(restored ?? empty, Boolean(restored));
      } catch (err: any) {
        if (cancelled) return;
        setStoreError(err.message || t("Could not reach project storage."));
        const empty = createEmptySession(llmConfig);
        if (activeId) empty.id = activeId;
        applySession(empty, false);
      }
    };

    hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist every change back to SQLite. An empty untitled draft stays out of
  // history, but one that already holds work is kept: tasks added straight on
  // the Kanban of a new chat used to vanish on reload.
  useEffect(() => {
    if (!session) return;
    const snapshot = JSON.stringify(session);
    if (snapshot === lastPersistedRef.current) return;
    lastPersistedRef.current = snapshot;
    const holdsWork = Boolean(session.tasks?.length || session.prd || session.plan);
    if (!session.input.title && !session.title && !holdsWork) return;

    persistSession(session)
      .then(refreshHistory)
      .catch((err: Error) => setStoreError(err.message));
  }, [session]);

  const handleUpdateSession = (update: SessionUpdate) => {
    setSession((prev) => {
      if (!prev) return prev;
      const updatedFields = typeof update === "function" ? update(prev) : update;
      if (!updatedFields) return prev;
      return {
        ...prev,
        ...updatedFields,
        updatedAt: new Date().toISOString(),
      };
    });
  };

  const handleSelectStep = (step: Step) => {
    handleUpdateSession({ currentStep: step });
    handleLayoutModeChange(isNarrow ? "board" : "split");
  };


  const handleOpenChatStep = async (id: string, step: Step) => {
    if (session?.id !== id) await handleSelectHistorySession(id);
    handleSelectStep(step);
  };

  // Opens one chat of a project. Several chats share a folder's project, so
  // the chat is picked first and the chat pane reloads on chatKey.
  const handleOpenChat = async (projectId: string, conversationId: string) => {
    saveConversationId(projectId, conversationId);
    if (session?.id !== projectId) await handleSelectHistorySession(projectId);
    setChatKey((key) => key + 1);
  };

  const handleNewChatInFolder = async (projectId: string) => {
    await handleOpenChat(projectId, newConversationId());
    handleLayoutModeChange("agent");
  };

  const handleDeleteChat = async (projectId: string, conversationId: string) => {
    try {
      await removeChat(conversationId);
      if (session?.id === projectId && loadConversationId(projectId) === conversationId) {
        saveConversationId(projectId, newConversationId());
        setChatKey((key) => key + 1);
      }
      await refreshHistory();
    } catch (err: any) {
      setStoreError(err.message || t("Failed to delete the chat."));
    }
  };

  // A new chat stays in the folder it was started from: it shares that folder's
  // plan, PRD, board and memory. Without a folder it starts a project of its own.
  const handleNewProject = () => {
    if (!session) return;
    const owner = session.workspaceRoot ? projectForFolder(historySessions, session.workspaceRoot) : null;
    if (owner) {
      void handleOpenChat(owner.id, newConversationId());
      return;
    }
    applySession(createEmptySession(session.llmConfig), false);
  };

  const handleWorkspaceSelected = async (workspaceRoot: string) => {
    if (!session) return;
    // The folder already has a project: the chat joins it instead of starting a
    // second one there. A chat with a plan or tasks of its own keeps them, as
    // its own project, unless the user says to open the folder's one.
    const owner = projectForFolder(historySessions, workspaceRoot, session.id);
    if (owner) {
      const ownWork = Boolean(session.plan || session.prd || session.tasks?.length);
      if (ownWork && !window.confirm(t("This folder already has a project with its own plan and board. Open it in a new chat? This chat keeps its own plan and stays where it is."))) return;
      // A chat that is not saved as a project yet carries its messages into the folder's project.
      const current = loadConversationId(session.id);
      const saved = historySessions.some((item) => item.id === session.id);
      await handleOpenChat(owner.id, !ownWork && !saved && current ? current : newConversationId());
      return;
    }
    const inferredName = projectNameFromWorkspaceRoot(workspaceRoot);
    const existingName = session.input.title.trim() || session.title.trim();
    const projectName = existingName || inferredName;
    const next: ProjectSession = {
      ...session,
      workspaceRoot,
      title: projectName,
      input: { ...session.input, title: projectName },
      updatedAt: new Date().toISOString(),
    };

    await persistSession(next);
    lastPersistedRef.current = JSON.stringify(next);
    setSession(next);
    saveActiveSessionId(next.id);
    await refreshHistory();
  };

  const handleSelectSample = (sample: SampleProject) => {
    if (!session) return;
    const { input } = sampleText(sample, lang);
    applySession(
      {
        ...createEmptySession(session.llmConfig),
        title: input.title,
        input,
        workspaceRoot: session.workspaceRoot,
        allowShell: session.allowShell,
      },
      false
    );
  };

  const handleSelectHistorySession = async (id: string) => {
    if (!session) return;
    try {
      const loaded = await fetchSession(id, session.llmConfig);
      if (!loaded) {
        setStoreError(t("That project session no longer exists in storage."));
        await refreshHistory();
        return;
      }
      applySession(loaded, true);
    } catch (err: any) {
      setStoreError(err.message || t("Failed to open the project session."));
    }
  };

  const handleDeleteHistory = async (id: string) => {
    try {
      await removeSession(id);
      await refreshHistory();
      if (session?.id === id) {
        applySession(createEmptySession(session.llmConfig), false);
      }
    } catch (err: any) {
      setStoreError(err.message || t("Failed to delete the project session."));
    }
  };

  if (!session) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted">
          <RefreshCw className="w-4 h-4 animate-spin text-accent-ink" />
          {t("Loading project history...")}
        </div>
      </div>
    );
  }

  return (
    <LanguageProvider value={{ lang, t }}>
    <div className="flex h-screen overflow-hidden bg-canvas text-sm text-ink font-sans antialiased selection:bg-accent selection:text-accent-fg">
      <Sidebar
        session={session}
        historySessions={historySessions}
        onSelectAgent={() => handleLayoutModeChange("agent")}
        onNewProject={handleNewProject}
        onSelectHistorySession={handleSelectHistorySession}
        onOpenChatStep={handleOpenChatStep}
        onDeleteHistory={handleDeleteHistory}
        activeChatId={loadConversationId(session.id)}
        onOpenChat={handleOpenChat}
        onNewChatInFolder={handleNewChatInFolder}
        onDeleteChat={handleDeleteChat}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        collapsed={isSidebarCollapsed}
        onToggleCollapsed={toggleSidebarCollapsed}
      />

      {/* min-w-0 supaya kanvas dan tabel lebar di dalamnya menggulung sendiri,
          bukan melebarkan seluruh kolom dan mendorong sidebar keluar layar. */}
      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar
          session={session}
          onOpenMenu={() => setIsSidebarOpen(true)}
          onOpenExport={() => setIsExportModalOpen(true)}
          layoutMode={effectiveLayoutMode}
          onLayoutModeChange={handleLayoutModeChange}
          isNarrow={isNarrow}
          onOpenConnections={() => { setConnectionsInitialTab("connections"); setIsConnectionsModalOpen(true); }}
          onOpenSettings={() => setIsAgentSettingsOpen(true)}
          onOpenBugReport={() => setIsBugReportOpen(true)}
          onOpenDonate={() => setIsDonateOpen(true)}
          onSelectSample={handleSelectSample}
          theme={theme}
          onToggleTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
          accent={accent}
          onSelectAccent={setAccent}
          onSelectLanguage={selectLanguage}
        />

        <Workbench
          session={session}
          storeError={storeError}
          onDismissStoreError={() => setStoreError(null)}
          onUpdateSession={handleUpdateSession}
          onWorkspaceSelected={handleWorkspaceSelected}
          onSelectStep={handleSelectStep}
          onToolApplied={async () => {
            try {
              const fresh = await fetchSession(session.id, session.llmConfig);
              if (fresh) setSession(fresh);
            } catch (err: any) {
              setStoreError(err?.message || t("Failed to open the project session."));
            }
          }}
          layoutMode={effectiveLayoutMode}
          ratio={layout.ratio}
          onLayoutModeChange={handleLayoutModeChange}
          onRatioChange={handleRatioChange}
          onRatioCommit={handleRatioCommit}
          onOpenConnections={() => { setConnectionsInitialTab("connections"); setIsConnectionsModalOpen(true); }}
          harnessSettings={agentHarnessSettings}
          chatKey={chatKey}
          onChatTurnEnded={refreshHistory}
        />
      </div>

      <ConnectionsModal
        isOpen={isConnectionsModalOpen}
        initialTab={connectionsInitialTab}
        onClose={() => setIsConnectionsModalOpen(false)}
      />

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        session={session}
      />

      <BugReportModal isOpen={isBugReportOpen} onClose={() => setIsBugReportOpen(false)} />
      <DonateModal isOpen={isDonateOpen} onClose={() => setIsDonateOpen(false)} />

      <AgentSettingsModal
        isOpen={isAgentSettingsOpen}
        settings={agentHarnessSettings}
        onChange={updateAgentHarnessSettings}
        onClose={() => setIsAgentSettingsOpen(false)}
      />
    </div>
    </LanguageProvider>
  );
}
