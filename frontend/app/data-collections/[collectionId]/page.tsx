import CollectionDetailClient from "@/components/data-collections/CollectionDetailClient";

export function generateStaticParams() {
  return [{ collectionId: "preview" }];
}

export default function CollectionDetailPage() {
  return <CollectionDetailClient />;
}
