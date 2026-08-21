import TaskDetailClient from "./TaskDetailClient";

export function generateStaticParams() {
  // The page is a client-side task detail view. A deterministic shell keeps
  // Next static export compatible with Workers Assets; live task IDs are
  // loaded from the authenticated API by the client component.
  return [{ task_id: "preview" }];
}

export default function TaskDetailPage() {
  return <TaskDetailClient />;
}
