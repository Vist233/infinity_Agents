import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Terminal, FileText, Microscope, ExternalLink } from "lucide-react";

const BILIBILI_VIDEO_URL =
  "https://www.bilibili.com/video/BV1McfHYfEkk/?spm_id_from=333.1387.upload.video_card.click";
const BILIBILI_EMBED_URL =
  "https://player.bilibili.com/player.html?bvid=BV1McfHYfEkk&page=1&high_quality=1";

export default function TraitAgentPage() {
  return (
    <div className="flex h-screen bg-white text-zinc-900 font-sans">
      <aside className="w-[260px] bg-zinc-50 border-r border-zinc-200 hidden md:flex flex-col p-3">
        <div className="space-y-1">
          <div className="text-[11px] uppercase tracking-widest text-zinc-400 px-2">Agents</div>
          <div className="space-y-1">
            <Link
              href="/code-agent"
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
            >
              <Terminal size={16} />
              <span className="truncate">CodeAgent</span>
            </Link>
            <Link
              href="/"
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
            >
              <FileText size={16} />
              <span className="truncate">PaperAgent</span>
            </Link>
            <Link
              href="/trait-agent"
              className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg bg-zinc-200 text-zinc-900"
            >
              <Microscope size={16} />
              <span className="truncate">TraitRecognize</span>
            </Link>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col">
        <header className="h-14 border-b border-zinc-100 flex items-center px-4 justify-between bg-white/80 backdrop-blur-md">
          <div className="text-sm font-semibold tracking-tight text-zinc-500">Trait Agent Demo</div>
          <Button asChild variant="ghost" size="sm" className="text-zinc-500">
            <a href={BILIBILI_VIDEO_URL} target="_blank" rel="noreferrer">
              在 Bilibili 打开
            </a>
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="max-w-5xl mx-auto px-4 py-8 space-y-5">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">TraitRecognize 演示视频</h1>
              <p className="text-zinc-500 text-sm mt-2">
                当前版本先提供功能演示视频，后续再切换为完整 Agent 交互页。
              </p>
            </div>

            <section className="rounded-2xl border border-zinc-200 bg-white shadow-sm p-3 md:p-4">
              <div className="relative w-full overflow-hidden rounded-xl bg-black" style={{ paddingTop: "56.25%" }}>
                <iframe
                  src={BILIBILI_EMBED_URL}
                  title="TraitRecognize 演示视频"
                  loading="lazy"
                  allowFullScreen
                  className="absolute inset-0 h-full w-full border-0"
                  referrerPolicy="strict-origin-when-cross-origin"
                />
              </div>
            </section>

            <div className="flex items-center gap-3">
              <Button asChild variant="outline" className="border-zinc-200">
                <a href={BILIBILI_VIDEO_URL} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  无法播放？点击在 Bilibili 查看
                </a>
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
