import type { SessionRunState } from "@/lib/chat-state";

interface RunStatusProps {
  isLoading: boolean;
  statusText: string;
  runState: SessionRunState;
}

export function RunStatus({ isLoading, statusText, runState }: RunStatusProps) {
  if (!isLoading) return null;

  return (
    <>
      <span className="inline-block w-1.5 h-4 bg-zinc-900 animate-pulse ml-1 align-middle" />
      <span className="ml-2 text-[11px] text-zinc-400">{statusText}</span>
      {runState.activeTools.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {runState.activeTools.map((tool) => (
            <span
              key={tool}
              className="inline-flex items-center rounded-full border border-zinc-300 bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600"
            >
              Running: {tool}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
