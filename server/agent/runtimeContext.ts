// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import type { Message } from "../llm/types.ts";

/** What the chat route records on each message it writes for a runtime run. */
export interface RuntimeMessageMeta {
  runtime?: string;
  runId?: string;
}

export interface StoredMessage extends Message {
  meta: RuntimeMessageMeta;
}

const MAX_MESSAGES = 40;
const MAX_CHARS = 24_000;

function messageText(message: Message): string {
  return message.content
    .flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The messages a provider session has not seen: everything after the last
 * message written by one of its own runs, or the whole conversation for a
 * session that is new. A chat can move between runtimes; each keeps its own
 * session, so without this a runtime answers without what was said elsewhere.
 */
export function unseenMessages(messages: StoredMessage[], sessionRunIds: ReadonlySet<string>): StoredMessage[] {
  let lastSeen = -1;
  messages.forEach((message, index) => {
    if (message.meta.runId && sessionRunIds.has(message.meta.runId)) lastSeen = index;
  });
  return messages.slice(lastSeen + 1);
}

export interface ConversationContext {
  prompt: string;
  /** Messages placed in the context block. */
  included: number;
  /** Unseen messages left out to stay within the limits. */
  omitted: number;
}

/** Prefix a runtime prompt with the part of the conversation it has not seen. */
export function withConversationContext(prompt: string, unseen: Message[]): ConversationContext {
  const lines: string[] = [];
  let used = 0;
  // Newest first, so a long history keeps what was said most recently.
  for (const message of unseen.slice(-MAX_MESSAGES).reverse()) {
    const text = messageText(message);
    if (!text) continue;
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
    if (used + line.length > MAX_CHARS) break;
    lines.unshift(line);
    used += line.length;
  }
  const withText = unseen.filter((message) => messageText(message)).length;
  if (!lines.length) return { prompt, included: 0, omitted: withText };
  return {
    prompt: [
      "<conversation_context>",
      "Earlier in this conversation, before this session saw it (possibly with another assistant):",
      "",
      lines.join("\n\n"),
      "</conversation_context>",
      "",
      prompt,
    ].join("\n"),
    included: lines.length,
    omitted: withText - lines.length,
  };
}
