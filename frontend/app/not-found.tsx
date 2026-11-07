export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--surface-0)] px-6 py-16 text-zinc-900">
      <div className="w-full max-w-xl">
        <p className="text-xs font-semibold tracking-[0.2em] text-zinc-500">404 / STATIC SHOWCASE</p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">这个页面或在线功能已下线。</h1>
        <p className="mt-5 text-base leading-7 text-zinc-600">
          Infinity 现在是一个纯静态展示。云端任务、论文处理、图片判分和登录服务已经停止。
          源码和本地运行方法见 GitHub。
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href="https://github.com/Vist233/infinity_Agents"
            className="inline-flex min-h-11 items-center rounded-lg bg-zinc-900 px-5 text-sm font-medium text-white hover:bg-zinc-700"
          >
            GitHub 源码与说明 ↗
          </a>
          <a
            href="/"
            className="inline-flex min-h-11 items-center rounded-lg border border-zinc-300 px-5 text-sm font-medium text-zinc-800 hover:bg-zinc-100"
          >
            返回首页
          </a>
        </div>
        <p className="mt-8 text-xs leading-6 text-zinc-500">
          直接请求旧接口也会返回这个页面。仓库：https://github.com/Vist233/infinity_Agents
        </p>
      </div>
    </main>
  );
}
