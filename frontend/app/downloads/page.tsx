import { redirect } from "next/navigation";

/** ImageJudge owns the only desktop download entry. */
export default function DownloadsPage() {
  redirect("/image-judge/");
}
