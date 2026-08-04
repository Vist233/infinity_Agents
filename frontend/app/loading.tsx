export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-3">
        <div className="h-5 w-48 bg-zinc-200 rounded animate-pulse" />
        <div className="h-20 w-full bg-zinc-200 rounded-2xl animate-pulse" />
        <div className="h-20 w-full bg-zinc-200 rounded-2xl animate-pulse" />
        <div className="h-20 w-full bg-zinc-200 rounded-2xl animate-pulse" />
      </div>
    </div>
  );
}
