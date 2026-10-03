import type { SessionSummary } from "../types";

// A folder has one project: its plan, PRD, board and memory, shared by every
// chat in that folder. Folders saved before this could hold several; the one
// with work in it wins and the others stay listed as they were.

const holdsWork = (session: SessionSummary): boolean => Boolean(session.hasPlan || session.taskCount);

const newest = (a: SessionSummary, b: SessionSummary): number =>
  (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0);

/** The project a folder's chats share: the newest one with a plan or tasks, else the newest. */
export function folderProject(sessions: SessionSummary[]): SessionSummary | null {
  const sorted = [...sessions].sort(newest);
  return sorted.find(holdsWork) ?? sorted[0] ?? null;
}

/** The project that already owns `workspaceRoot`, leaving out `exceptId`. */
export function projectForFolder(sessions: SessionSummary[], workspaceRoot: string, exceptId?: string): SessionSummary | null {
  const root = workspaceRoot.trim();
  if (!root) return null;
  return folderProject(sessions.filter((session) => session.id !== exceptId && (session.workspaceRoot ?? "").trim() === root));
}
