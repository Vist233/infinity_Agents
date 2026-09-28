import { redirect } from "next/navigation";

/** Data Collections is no longer a cloud product area; papers is the supported entry. */
export default function DataCollectionsPage() {
  redirect("/papers/");
}
