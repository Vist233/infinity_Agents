export interface Message {
  role: "user" | "assistant";
  content: string;
}

import type { PaperTaskCandidate } from "@/lib/paper-task";

const EMPTY_PAPER_TASKS: PaperTaskCandidate[] = [];

export type ToolTimelineStatus = "pending" | "processing" | "succeeded" | "failed" | "unknown";

export interface ToolTimelineEntry {
  correlationId: string;
  toolCallId: string;
  toolName: string;
  status: ToolTimelineStatus;
  summary: string;
  argumentsSummary?: string;
}

export interface SessionItem {
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export type RunPhase = "thinking" | "tool_running" | "responding" | "retrying";
export type TerminalState = "success" | "error" | "stopped";

export interface TokenInfo {
  prompt: number;
  response: number;
  total: number;
}

export interface SessionRunState {
  running: boolean;
  phase: RunPhase | null;
  toolName: string | null;
  unreadDone: boolean;
  terminal: TerminalState | null;
  requestId: string | null;
  elapsedMs: number;
  attempt: number;
  maxAttempts: number;
  reason: string | null;
  hasReceivedChunk: boolean;
  hasReceivedToolCall: boolean;
  activeTools: string[];
  tokenInfo: TokenInfo | null;
}

export interface ChatState {
  input: string;
  sessionId: string | null;
  sessions: SessionItem[];
  sessionMessagesMap: Record<string, Message[]>;
  sessionToolTimelineMap: Record<string, ToolTimelineEntry[]>;
  sessionPaperTaskMap: Record<string, PaperTaskCandidate[]>;
  sessionLegacyHistoryMap: Record<string, boolean>;
  sessionRunMap: Record<string, SessionRunState>;
  editingSessionId: string | null;
  editingTitle: string;
  deletingSessionId: string | null;
  uiError: string | null;
}

export const DEFAULT_RUN_STATE: SessionRunState = {
  running: false,
  phase: null,
  toolName: null,
  unreadDone: false,
  terminal: null,
  requestId: null,
  elapsedMs: 0,
  attempt: 1,
  maxAttempts: 2,
  reason: null,
  hasReceivedChunk: false,
  hasReceivedToolCall: false,
  activeTools: [],
  tokenInfo: null,
};

export const INITIAL_CHAT_STATE: ChatState = {
  input: "",
  sessionId: null,
  sessions: [],
  sessionMessagesMap: {},
  sessionToolTimelineMap: {},
  sessionPaperTaskMap: {},
  sessionLegacyHistoryMap: {},
  sessionRunMap: {},
  editingSessionId: null,
  editingTitle: "",
  deletingSessionId: null,
  uiError: null,
};

export type ChatAction =
  | { type: "set_input"; input: string }
  | { type: "set_session_id"; sessionId: string | null }
  | { type: "set_sessions"; sessions: SessionItem[] }
  | { type: "set_session_messages"; sessionId: string; messages: Message[] }
  | { type: "update_session_messages"; sessionId: string; updater: (prev: Message[]) => Message[] }
  | { type: "set_session_tool_timeline"; sessionId: string; timeline: ToolTimelineEntry[]; legacyTextOnly: boolean }
  | { type: "upsert_session_tool_timeline"; sessionId: string; entry: ToolTimelineEntry }
  | { type: "update_session_tool_timeline"; sessionId: string; toolCallId: string; patch: Partial<ToolTimelineEntry> }
  | { type: "set_session_paper_tasks"; sessionId: string; tasks: PaperTaskCandidate[] }
  | { type: "upsert_session_paper_task"; sessionId: string; task: PaperTaskCandidate }
  | { type: "upsert_session"; session: SessionItem; toTop?: boolean }
  | { type: "remove_session"; sessionId: string }
  | { type: "set_session_run_state"; sessionId: string; runState: SessionRunState }
  | { type: "patch_session_run_state"; sessionId: string; patch: Partial<SessionRunState> }
  | { type: "update_session_run_state"; sessionId: string; updater: (prev: SessionRunState) => SessionRunState }
  | { type: "set_editing_session"; sessionId: string | null; title?: string }
  | { type: "set_editing_title"; title: string }
  | { type: "set_deleting_session"; sessionId: string | null }
  | { type: "set_error"; error: string | null }
  | { type: "reset_new_chat" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "set_input":
      return { ...state, input: action.input };
    case "set_session_id":
      return { ...state, sessionId: action.sessionId };
    case "set_sessions":
      return { ...state, sessions: action.sessions };
    case "set_session_messages":
      return {
        ...state,
        sessionMessagesMap: {
          ...state.sessionMessagesMap,
          [action.sessionId]: action.messages,
        },
      };
    case "update_session_messages": {
      const current = state.sessionMessagesMap[action.sessionId] || [];
      return {
        ...state,
        sessionMessagesMap: {
          ...state.sessionMessagesMap,
          [action.sessionId]: action.updater(current),
        },
      };
    }
    case "set_session_tool_timeline":
      return {
        ...state,
        sessionToolTimelineMap: { ...state.sessionToolTimelineMap, [action.sessionId]: action.timeline },
        sessionLegacyHistoryMap: { ...state.sessionLegacyHistoryMap, [action.sessionId]: action.legacyTextOnly },
      };
    case "upsert_session_tool_timeline": {
      const current = state.sessionToolTimelineMap[action.sessionId] || [];
      const index = current.findIndex((entry) => entry.toolCallId === action.entry.toolCallId);
      const timeline = index === -1
        ? [...current, action.entry]
        : current.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...action.entry } : entry);
      return {
        ...state,
        sessionToolTimelineMap: { ...state.sessionToolTimelineMap, [action.sessionId]: timeline },
      };
    }
    case "update_session_tool_timeline": {
      const current = state.sessionToolTimelineMap[action.sessionId] || [];
      return {
        ...state,
        sessionToolTimelineMap: {
          ...state.sessionToolTimelineMap,
          [action.sessionId]: current.map((entry) => entry.toolCallId === action.toolCallId ? { ...entry, ...action.patch } : entry),
        },
      };
    }
    case "set_session_paper_tasks":
      return {
        ...state,
        sessionPaperTaskMap: { ...state.sessionPaperTaskMap, [action.sessionId]: action.tasks },
      };
    case "upsert_session_paper_task": {
      const current = state.sessionPaperTaskMap[action.sessionId] || [];
      return {
        ...state,
        sessionPaperTaskMap: {
          ...state.sessionPaperTaskMap,
          [action.sessionId]: [
            ...current.filter((task) => task.resourceId !== action.task.resourceId),
            action.task,
          ],
        },
      };
    }
    case "upsert_session": {
      const exists = state.sessions.some((s) => s.session_id === action.session.session_id);
      if (!exists) {
        return {
          ...state,
          sessions: action.toTop ? [action.session, ...state.sessions] : [...state.sessions, action.session],
        };
      }
      const updated = state.sessions.map((session) =>
        session.session_id === action.session.session_id ? action.session : session,
      );
      if (!action.toTop) {
        return { ...state, sessions: updated };
      }
      const target = updated.find((session) => session.session_id === action.session.session_id);
      return {
        ...state,
        sessions: target ? [target, ...updated.filter((session) => session.session_id !== action.session.session_id)] : updated,
      };
    }
    case "remove_session": {
      const nextMessages = { ...state.sessionMessagesMap };
      delete nextMessages[action.sessionId];
      const nextRunMap = { ...state.sessionRunMap };
      delete nextRunMap[action.sessionId];
      const nextToolTimelineMap = { ...state.sessionToolTimelineMap };
      delete nextToolTimelineMap[action.sessionId];
      const nextPaperTaskMap = { ...state.sessionPaperTaskMap };
      delete nextPaperTaskMap[action.sessionId];
      const nextLegacyHistoryMap = { ...state.sessionLegacyHistoryMap };
      delete nextLegacyHistoryMap[action.sessionId];
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.session_id !== action.sessionId),
        sessionMessagesMap: nextMessages,
        sessionRunMap: nextRunMap,
        sessionToolTimelineMap: nextToolTimelineMap,
        sessionPaperTaskMap: nextPaperTaskMap,
        sessionLegacyHistoryMap: nextLegacyHistoryMap,
        sessionId: state.sessionId === action.sessionId ? null : state.sessionId,
      };
    }
    case "set_session_run_state":
      return {
        ...state,
        sessionRunMap: {
          ...state.sessionRunMap,
          [action.sessionId]: action.runState,
        },
      };
    case "patch_session_run_state": {
      const current = state.sessionRunMap[action.sessionId] || DEFAULT_RUN_STATE;
      return {
        ...state,
        sessionRunMap: {
          ...state.sessionRunMap,
          [action.sessionId]: { ...current, ...action.patch },
        },
      };
    }
    case "update_session_run_state": {
      const current = state.sessionRunMap[action.sessionId] || DEFAULT_RUN_STATE;
      return {
        ...state,
        sessionRunMap: {
          ...state.sessionRunMap,
          [action.sessionId]: action.updater(current),
        },
      };
    }
    case "set_editing_session":
      return {
        ...state,
        editingSessionId: action.sessionId,
        editingTitle: action.title ?? state.editingTitle,
      };
    case "set_editing_title":
      return { ...state, editingTitle: action.title };
    case "set_deleting_session":
      return { ...state, deletingSessionId: action.sessionId };
    case "set_error":
      return { ...state, uiError: action.error };
    case "reset_new_chat":
      return { ...state, sessionId: null, input: "", deletingSessionId: null };
    default:
      return state;
  }
}

export const getMessagesForSession = (state: ChatState, sessionId: string | null) =>
  sessionId ? (state.sessionMessagesMap[sessionId] || []) : [];

export const getRunStateForSession = (state: ChatState, sessionId: string | null) =>
  sessionId ? (state.sessionRunMap[sessionId] || DEFAULT_RUN_STATE) : DEFAULT_RUN_STATE;

export const getToolTimelineForSession = (state: ChatState, sessionId: string | null) =>
  sessionId ? (state.sessionToolTimelineMap[sessionId] || []) : [];

export const getPaperTasksForSession = (state: ChatState, sessionId: string | null) =>
  sessionId ? (state.sessionPaperTaskMap[sessionId] || EMPTY_PAPER_TASKS) : EMPTY_PAPER_TASKS;

export const deriveSessionTitle = (rawInput: string) => {
  const normalized = rawInput.replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  return normalized.length > 32 ? `${normalized.slice(0, 32)}...` : normalized;
};

export const isDefaultSessionTitle = (title?: string | null) => {
  const t = (title || "").trim().toLowerCase();
  return !t || t === "new chat" || t === "untitled" || t === "新对话";
};
