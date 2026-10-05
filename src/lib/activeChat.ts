import { prefs } from "./prefs";

// Which chat of a project is open. A folder's project is shared by all its
// chats, so the project id alone no longer says which conversation to show.
// The pick lives in this browser; the server keeps the conversations.

const CONVERSATION_STORAGE_PREFIX = "ai_plan_architect_agent_conversation_v1";

function conversationStorageKey(sessionId: string): string {
  return `${CONVERSATION_STORAGE_PREFIX}:${encodeURIComponent(sessionId)}`;
}

export function loadConversationId(sessionId: string): string | null {
  try {
    return prefs.get(conversationStorageKey(sessionId));
  } catch {
    return null;
  }
}

export function saveConversationId(sessionId: string, conversationId: string): void {
  try {
    prefs.set(conversationStorageKey(sessionId), conversationId);
  } catch {
    // Conversation persistence is best effort; the server remains authoritative.
  }
}

/** An id for a chat not started yet; the server creates it with the first message. */
export function newConversationId(): string {
  return `conv_${crypto.randomUUID()}`;
}
