import PaperDetailClient from "@/components/papers/PaperDetailClient";

export function generateStaticParams() {
  return [{ paperId: "preview" }];
}

export default function PaperDetailPage() {
  return <PaperDetailClient />;
}
