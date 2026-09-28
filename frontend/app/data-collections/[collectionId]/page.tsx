import { redirect } from "next/navigation";

export function generateStaticParams() {
  return [{ collectionId: "preview" }];
}

/** Legacy collection URLs return to the supported paper workspace. */
export default function CollectionDetailPage() {
  redirect("/papers/");
}
