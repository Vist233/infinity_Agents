"use client";

import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AgentNav } from "@/components/chat/AgentNav";

const videoUrl = "https://www.bilibili.com/video/BV1McfHYfEkk/";
const embedUrl = "https://player.bilibili.com/player.html?bvid=BV1McfHYfEkk&page=1&high_quality=1";

export default function TraitAgentPage() {
  const router = useRouter();

  return (
    <div className="flex h-screen bg-transparent text-zinc-900 font-sans">
      <aside className="w-[260px] bg-[var(--surface-1)] border-r border-[var(--hairline)] hidden md:flex flex-col p-3 backdrop-blur-xl">
        <AgentNav active="trait" onNavigate={(path) => router.push(path)} />
      </aside>
      <main className="flex-1 flex flex-col overflow-y-auto">
        <header className="h-14 border-b border-[var(--hairline)] flex items-center px-4 justify-between bg-[var(--surface-1)] backdrop-blur-xl">
          <div className="text-sm font-semibold tracking-tight text-zinc-700">Trait Agent Demo</div>
          <Button asChild variant="ghost" size="sm"><a href={videoUrl} target="_blank" rel="noreferrer">在 Bilibili 打开</a></Button>
        </header>
        <div className="max-w-5xl mx-auto w-full px-4 py-8 space-y-5">
          <div><h1 className="text-2xl font-semibold tracking-tight">TraitRecognize 演示视频</h1><p className="text-zinc-500 text-sm mt-2">当前先提供功能演示视频，后续可切换为完整 Agent 交互页。</p></div>
          <section className="rounded-2xl border border-[var(--hairline)] bg-white/90 shadow-sm p-3 md:p-4 backdrop-blur"><div className="relative w-full overflow-hidden rounded-xl bg-black" style={{ paddingTop: "56.25%" }}><iframe src={embedUrl} title="TraitRecognize 演示视频" loading="lazy" allowFullScreen className="absolute inset-0 h-full w-full border-0" referrerPolicy="strict-origin-when-cross-origin" /></div></section>
          <Button asChild variant="outline"><a href={videoUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4 mr-2" />无法播放？点击在 Bilibili 查看</a></Button>
        </div>
      </main>
    </div>
  );
}
