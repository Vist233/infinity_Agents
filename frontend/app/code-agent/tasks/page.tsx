import { redirect } from "next/navigation";

// The task list now lives directly on the Coding Agent main page.
export default function TasksIndexPage() {
  redirect("/task-center/");
}
