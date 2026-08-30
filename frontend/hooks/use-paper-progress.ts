"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getPaperResourceProgress,
  resumePaperContinuation,
  type PaperApiError,
  type PaperResourceProgress,
  type PaperResourceProgressStatus,
} from "@/lib/api/papers";
import { consumeChatEventStream, type ChatEvent } from "@/lib/ws/chat-stream";
import { derivePaperTaskCandidates, type PaperTaskCandidate } from "@/lib/paper-task";
import type { ToolTimelineEntry } from "@/lib/chat-state";

export const PAPER_PROGRESS_POLL_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const EMPTY_PAPER_TASK_CANDIDATES: PaperTaskCandidate[] = [];

export type PaperTaskPhase = "loading" | "progress" | "error" | "absent" | "denied";

export interface PaperTaskRuntime {
  candidate: PaperTaskCandidate;
  phase: PaperTaskPhase;
  progress: PaperResourceProgress | null;
  /** Internal generic marker; server error text is read only from progress.resource.error. */
  errorMessage: "temporary_unavailable" | null;
  retryAttempt: number;
  resuming: boolean;
}

export interface UsePaperProgressOptions {
  apiBase: string;
  sessionId: string | null;
  toolTimeline: ToolTimelineEntry[];
  /** Server-projected identities recovered from canonical session history. */
  paperTaskCandidates?: PaperTaskCandidate[];
  onResumeStart?: (candidate: PaperTaskCandidate) => void;
  onContinuationEvent?: (event: ChatEvent, candidate: PaperTaskCandidate) => void;
}

export interface UsePaperProgressResult {
  tasks: PaperTaskRuntime[];
  visibleTasks: PaperTaskRuntime[];
  resumeTask: (resourceId: string) => Promise<void>;
}

const ACTIVE_STATUSES = new Set<PaperResourceProgressStatus>([
  "requested", "downloading", "extracting", "uploading",
]);

export function nextPaperProgressPollDelay(attempt: number): number {
  const index = Math.min(Math.max(Math.floor(attempt), 0), PAPER_PROGRESS_POLL_DELAYS_MS.length - 1);
  return PAPER_PROGRESS_POLL_DELAYS_MS[index];
}

function apiStatus(error: unknown): number | undefined {
  return (error as PaperApiError | undefined)?.status;
}

function isMissingOrDenied(status: number | undefined): "absent" | "denied" | null {
  if (status === 401 || status === 403) return "denied";
  if (status === 404 || status === 410) return "absent";
  return null;
}

export function usePaperProgress({
  apiBase,
  sessionId,
  toolTimeline,
  paperTaskCandidates = EMPTY_PAPER_TASK_CANDIDATES,
  onResumeStart,
  onContinuationEvent,
}: UsePaperProgressOptions): UsePaperProgressResult {
  const candidates = useMemo(() => {
    const byResource = new Map<string, PaperTaskCandidate>();
    for (const candidate of paperTaskCandidates) byResource.set(candidate.resourceId, candidate);
    for (const candidate of derivePaperTaskCandidates(toolTimeline)) byResource.set(candidate.resourceId, candidate);
    return [...byResource.values()];
  }, [paperTaskCandidates, toolTimeline]);
  const [tasksByResourceId, setTasksByResourceId] = useState<Record<string, PaperTaskRuntime>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const generationRef = useRef(0);
  const lastSessionRef = useRef<string | null>(null);
  const timersRef = useRef<Map<string, number>>(new Map());
  const inFlightResumeRef = useRef<Map<string, Promise<void>>>(new Map());
  const onResumeStartRef = useRef(onResumeStart);
  const onContinuationEventRef = useRef(onContinuationEvent);
  onResumeStartRef.current = onResumeStart;
  onContinuationEventRef.current = onContinuationEvent;

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const sessionChanged = lastSessionRef.current !== sessionId;
    lastSessionRef.current = sessionId;
    const timers = timersRef.current;
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.clear();

    if (!sessionId || candidates.length === 0) {
      setTasksByResourceId({});
      return () => {
        if (generationRef.current === generation) generationRef.current += 1;
      };
    }

    setTasksByResourceId((previous) => {
      const next: Record<string, PaperTaskRuntime> = {};
      const source = sessionChanged ? {} : previous;
      for (const candidate of candidates) {
        const existing = source[candidate.resourceId];
        next[candidate.resourceId] = existing && existing.candidate.toolCallId === candidate.toolCallId
          ? { ...existing, candidate }
          : {
              candidate,
              phase: "loading",
              progress: null,
              errorMessage: null,
              retryAttempt: 0,
              resuming: false,
            };
      }
      return next;
    });

    const clearTimer = (resourceId: string) => {
      const timer = timers.get(resourceId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(resourceId);
      }
    };

    const updateTask = (resourceId: string, patch: Partial<PaperTaskRuntime>) => {
      if (generationRef.current !== generation) return;
      setTasksByResourceId((previous) => {
        const current = previous[resourceId];
        if (!current) return previous;
        return { ...previous, [resourceId]: { ...current, ...patch } };
      });
    };

    const schedule = (candidate: PaperTaskCandidate, attempt: number) => {
      if (generationRef.current !== generation) return;
      clearTimer(candidate.resourceId);
      const timer = window.setTimeout(() => {
        timers.delete(candidate.resourceId);
        void load(candidate, attempt + 1);
      }, nextPaperProgressPollDelay(attempt));
      timers.set(candidate.resourceId, timer);
    };

    const load = async (candidate: PaperTaskCandidate, attempt: number): Promise<void> => {
      if (generationRef.current !== generation) return;
      try {
        const progress = await getPaperResourceProgress(apiBase, sessionId, candidate.resourceId);
        if (generationRef.current !== generation) return;
        updateTask(candidate.resourceId, {
          phase: "progress",
          progress,
          errorMessage: null,
          retryAttempt: 0,
        });
        if (ACTIVE_STATUSES.has(progress.resource.status)) schedule(candidate, 0);
        else clearTimer(candidate.resourceId);
      } catch (error) {
        if (generationRef.current !== generation) return;
        const hidden = isMissingOrDenied(apiStatus(error));
        if (hidden) {
          clearTimer(candidate.resourceId);
          updateTask(candidate.resourceId, { phase: hidden, errorMessage: null });
          return;
        }
        updateTask(candidate.resourceId, {
          phase: "error",
          errorMessage: "temporary_unavailable",
          retryAttempt: attempt,
        });
        schedule(candidate, attempt);
      }
    };

    for (const candidate of candidates) void load(candidate, 0);

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, [apiBase, candidates, refreshVersion, sessionId]);

  const resumeTask = useCallback(async (resourceId: string) => {
    const task = tasksByResourceId[resourceId];
    const continuationId = task?.progress?.resume.available ? task.progress.resume.continuation_id : null;
    if (!task || !sessionId || !continuationId) return;
    const actionGeneration = generationRef.current;
    const actionKey = `${sessionId}\u0000${resourceId}`;
    const duplicate = inFlightResumeRef.current.get(actionKey);
    if (duplicate) return duplicate;
    const resumeStartHandler = onResumeStartRef.current;
    const continuationEventHandler = onContinuationEventRef.current;

    const promise = (async () => {
      setTasksByResourceId((previous) => generationRef.current === actionGeneration && previous[resourceId]
        ? { ...previous, [resourceId]: { ...previous[resourceId], resuming: true, errorMessage: null } }
        : previous);
      resumeStartHandler?.(task.candidate);
      try {
        const response = await resumePaperContinuation(apiBase, sessionId, continuationId);
        await consumeChatEventStream(response, (event) => {
          if (generationRef.current === actionGeneration) continuationEventHandler?.(event, task.candidate);
        });
        if (generationRef.current === actionGeneration) setRefreshVersion((version) => version + 1);
      } catch (error) {
        setTasksByResourceId((previous) => generationRef.current === actionGeneration && previous[resourceId]
          ? { ...previous, [resourceId]: { ...previous[resourceId], phase: "error", errorMessage: "temporary_unavailable" } }
          : previous);
        throw error;
      } finally {
        setTasksByResourceId((previous) => generationRef.current === actionGeneration && previous[resourceId]
          ? { ...previous, [resourceId]: { ...previous[resourceId], resuming: false } }
          : previous);
        inFlightResumeRef.current.delete(actionKey);
      }
    })();
    inFlightResumeRef.current.set(actionKey, promise);
    return promise;
  }, [apiBase, sessionId, tasksByResourceId]);

  const tasks = useMemo(() => Object.values(tasksByResourceId), [tasksByResourceId]);
  const visibleTasks = useMemo(
    () => tasks.filter((task) => task.phase !== "absent" && task.phase !== "denied"),
    [tasks],
  );
  return { tasks, visibleTasks, resumeTask };
}
