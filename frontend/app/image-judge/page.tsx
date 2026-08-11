"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDownToLine, ExternalLink, FileImage, Microscope, Upload } from "lucide-react";
import { AgentNav } from "@/components/chat/AgentNav";
import { MobileWorkspaceMenu } from "@/components/chat/MobileWorkspaceMenu";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/lib/i18n";
import { WorkspaceUserFooter } from "@/components/chat/WorkspaceUserFooter";

const RELEASE_URL = "https://github.com/Vist233/infinity_Agents/releases/latest";
const MAC_DOWNLOAD_URL = "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-macos.zip";
const WINDOWS_DOWNLOAD_URL = "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-windows-x64.zip";
const LINUX_DOWNLOAD_URL = "https://github.com/Vist233/infinity_Agents/releases/latest/download/ImageJudge-linux-amd64.deb";

const examples = [
  {
    id: "leaf",
    titleKey: "image.exampleLeaf",
    descriptionKey: "image.exampleLeafDescription",
    categories: ["PASS", "REVIEW", "FAILED"],
    referenceSrc: "/image-judge/leaf-reference.svg",
    uploadedSrc: "/image-judge/leaf-uploaded.svg",
    result: "PASS",
    resultDescriptionKey: "image.exampleResultPass",
  },
  {
    id: "sequence",
    titleKey: "image.exampleSequence",
    descriptionKey: "image.exampleSequenceDescription",
    categories: ["正常", "边界", "异常"],
    referenceSrc: "/image-judge/sequence-reference.svg",
    uploadedSrc: "/image-judge/sequence-uploaded.svg",
    result: "正常",
    resultDescriptionKey: "image.exampleResultNormal",
  },
] as const;

type DemoStatus = "idle" | "ready" | "running" | "succeeded" | "failed";

const IMAGE_FILE_EXTENSION = /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i;

function isUsableImageFile(file: File | null): file is File {
  if (!file || file.size <= 0) return false;
  return !file.type || file.type.startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name);
}

function FilePreview({ file, fallbackSrc, fallbackAlt, emptyLabel, accent }: { file: File | null; fallbackSrc: string; fallbackAlt: string; emptyLabel: string; accent: string }) {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (!file) {
      const timer = window.setTimeout(() => { if (active) setPreview(null); }, 0);
      return () => { active = false; window.clearTimeout(timer); };
    }
    const objectUrl = URL.createObjectURL(file);
    const timer = window.setTimeout(() => {
      if (active) setPreview({ file, url: objectUrl });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  if (preview?.file === file) return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={preview.url} alt={file?.name || emptyLabel} className="h-full w-full object-contain" />
  );
  if (fallbackSrc) return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={fallbackSrc} alt={fallbackAlt} className="h-full w-full object-cover" />
  );
  return <div className={`flex h-full items-center justify-center text-center text-sm ${accent}`}>{emptyLabel}</div>;
}

export default function ImageJudgePage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [selectedId, setSelectedId] = useState<(typeof examples)[number]["id"]>("leaf");
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [showDownload, setShowDownload] = useState(true);
  const [demoStatus, setDemoStatus] = useState<DemoStatus>("idle");
  const [demoError, setDemoError] = useState<string | null>(null);
  const demoTimerRef = useRef<number | null>(null);
  const selected = examples.find((example) => example.id === selectedId) ?? examples[0];

  useEffect(() => () => {
    if (demoTimerRef.current) window.clearTimeout(demoTimerRef.current);
  }, []);

  const updateDemoInputs = (nextReferenceFile: File | null, nextUploadedFile: File | null) => {
    if (demoTimerRef.current) {
      window.clearTimeout(demoTimerRef.current);
      demoTimerRef.current = null;
    }
    const hasInvalidFile = [nextReferenceFile, nextUploadedFile].some((file) => file !== null && !isUsableImageFile(file));
    setDemoError(hasInvalidFile ? t("image.demoInvalidInput") : null);
    if (hasInvalidFile) {
      setDemoStatus("failed");
    } else {
      setDemoStatus(nextReferenceFile && nextUploadedFile ? "ready" : "idle");
    }
  };

  const runLocalDemo = () => {
    if (!referenceFile || !uploadedFile || !isUsableImageFile(referenceFile) || !isUsableImageFile(uploadedFile)) {
      setDemoStatus("failed");
      setDemoError(t("image.demoInvalidInput"));
      return;
    }
    setDemoError(null);
    setDemoStatus("running");
    try {
      demoTimerRef.current = window.setTimeout(() => {
        demoTimerRef.current = null;
        setDemoStatus("succeeded");
      }, 240);
    } catch {
      demoTimerRef.current = null;
      setDemoStatus("failed");
      setDemoError(t("image.demoRunFailed"));
    }
  };

  const demoStatusText: Record<DemoStatus, string> = {
    idle: t("image.demoIdle"),
    ready: t("image.demoReady"),
    running: t("image.demoRunning"),
    succeeded: t("image.demoSuccess"),
    failed: demoError || t("image.demoRunFailed"),
  };

  return (
    <div className="flex h-screen bg-transparent font-sans text-zinc-900">
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-[var(--hairline)] bg-[var(--surface-1)] p-3 backdrop-blur-xl md:flex">
        <AgentNav active="traits" onNavigate={(path) => router.push(path)} />
        <button
          type="button"
          onClick={() => setShowDownload(true)}
          className={`mt-5 flex w-full items-center gap-2 rounded-xl px-3 py-3 text-left text-sm font-medium transition-colors ${showDownload ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
        >
          <ArrowDownToLine size={16} />
          {t("image.download")}
        </button>
        <div className="mt-5 px-2 text-[11px] uppercase tracking-[0.2em] text-zinc-400">{t("image.examples")}</div>
        <div className="mt-2 space-y-1">
          {examples.map((example) => (
            <button type="button" key={example.id} onClick={() => { setSelectedId(example.id); setShowDownload(false); }} className={`w-full rounded-xl px-3 py-3 text-left transition-colors ${selectedId === example.id && !showDownload ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}>
              <div className="text-sm font-medium">{t(example.titleKey)}</div>
              <div className={`mt-1 text-xs ${selectedId === example.id ? "text-zinc-300" : "text-zinc-400"}`}>{t(example.descriptionKey)}</div>
            </button>
          ))}
        </div>
        <div className="mt-auto"><WorkspaceUserFooter /></div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--hairline)] bg-[var(--surface-1)] px-4 backdrop-blur-xl">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-700">
            <MobileWorkspaceMenu
              active="traits"
              imageJudgeExamples={examples.map((example) => ({
                id: example.id,
                title: t(example.titleKey),
                description: t(example.descriptionKey),
              }))}
              imageJudgeSelectedId={selectedId}
              imageJudgeShowDownload={showDownload}
              onSelectImageJudgeExample={(id) => {
                const next = examples.find((example) => example.id === id);
                if (next) {
                  setSelectedId(next.id);
                  setShowDownload(false);
                }
              }}
              onOpenImageJudgeDownload={() => setShowDownload(true)}
            />
            <Microscope className="h-4 w-4" />
            {t("nav.imageJudge")}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl space-y-5 p-4 md:p-6">
            {showDownload && (
              <section className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm" id="download">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">{t("image.downloadTitle")}</h2>
                    <p className="mt-1 text-xs text-zinc-500">{t("image.downloadPanelDescription")}</p>
                  </div>
                  <a href={RELEASE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800"><ExternalLink className="h-3.5 w-3.5" />{t("image.releaseNotes")}</a>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button asChild size="sm" className="rounded-xl"><a href={MAC_DOWNLOAD_URL}><ArrowDownToLine className="h-4 w-4" />{t("image.downloadMac")}</a></Button>
                  <Button asChild size="sm" className="rounded-xl"><a href={WINDOWS_DOWNLOAD_URL}><ArrowDownToLine className="h-4 w-4" />{t("image.downloadWindows")}</a></Button>
                  <Button asChild size="sm" variant="outline" className="rounded-xl"><a href={LINUX_DOWNLOAD_URL}><ArrowDownToLine className="h-4 w-4" />{t("image.downloadLinux")}</a></Button>
                </div>
              </section>
            )}

            {!showDownload && <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
              <section className="rounded-3xl border border-zinc-200 bg-white/90 p-5 shadow-sm md:p-7">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600"><FileImage className="h-3.5 w-3.5" />{t("image.exampleBadge")}</div>
                    <h1 className="mt-4 text-2xl font-semibold tracking-tight">{t(selected.titleKey)}</h1>
                    <p className="mt-2 text-sm leading-6 text-zinc-600">{t(selected.descriptionKey)}</p>
                  </div>
                </div>

                <div className="mt-6 space-y-5">
                  <div>
                    <div className="mb-2 text-sm font-semibold text-zinc-700">{t("image.reference")}</div>
                    <div className="relative aspect-video overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-emerald-50 via-sky-50 to-zinc-100">
                      <FilePreview file={referenceFile} fallbackSrc={selected.referenceSrc} fallbackAlt={t("image.sampleReferenceAlt")} emptyLabel={t("image.referencePlaceholder")} accent="text-emerald-700/70" />
                      <label className="absolute bottom-3 right-3 inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/80 bg-white/90 px-3 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-white">
                        <Upload size={14} />{t("image.uploadReference")}
                        <input type="file" accept="image/*" className="sr-only" onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          setReferenceFile(file);
                          updateDemoInputs(file, uploadedFile);
                        }} />
                      </label>
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-sm font-semibold text-zinc-700">{t("image.uploaded")}</div>
                    <div className="relative aspect-video overflow-hidden rounded-2xl border border-dashed border-zinc-300 bg-zinc-50">
                      <FilePreview file={uploadedFile} fallbackSrc={selected.uploadedSrc} fallbackAlt={t("image.sampleUploadedAlt")} emptyLabel={t("image.uploadedPlaceholder")} accent="text-zinc-400" />
                      <label className="absolute bottom-3 right-3 inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/80 bg-white/90 px-3 py-2 text-xs font-medium text-zinc-700 shadow-sm hover:bg-white">
                        <Upload size={14} />{t("image.uploadTarget")}
                        <input type="file" accept="image/*" className="sr-only" onChange={(event) => {
                          const file = event.target.files?.[0] ?? null;
                          setUploadedFile(file);
                          updateDemoInputs(referenceFile, file);
                        }} />
                      </label>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="space-y-5">
                <section className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-zinc-700">{t("image.descriptionField")}</h2>
                  <p className="mt-3 text-sm leading-6 text-zinc-600">{t(selected.descriptionKey)}</p>
                </section>
                <section className="rounded-2xl border border-zinc-200 bg-white/90 p-5 shadow-sm">
                  <h2 className="text-sm font-semibold text-zinc-700">{t("image.categories")}</h2>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selected.categories.map((category) => <span key={category} className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600">{category}</span>)}
                  </div>
                  <div className="mt-5 rounded-xl border border-emerald-100 bg-emerald-50/70 p-4" aria-label={t("image.exampleResult")}>
                    <div className="text-xs font-semibold text-emerald-900">{t("image.exampleResult")}</div>
                    <div className="mt-2 inline-flex rounded-full bg-white px-3 py-1 text-xs font-semibold text-emerald-700">{selected.result}</div>
                    <p className="mt-2 text-xs leading-5 text-emerald-800">{t(selected.resultDescriptionKey)}</p>
                    <p className="mt-2 text-[11px] leading-4 text-emerald-700/70">{t("image.sampleFixture")}</p>
                  </div>
                  <div className="mt-5 rounded-xl border border-dashed border-zinc-200 bg-zinc-50 p-4 text-xs leading-5 text-zinc-600" aria-live="polite">
                    <div className="font-semibold text-zinc-700">{t("image.demoStatusTitle")}</div>
                    <div className="mt-1 text-zinc-500">{t("image.demoModeLabel")}</div>
                    <div className={`mt-3 rounded-lg px-3 py-2 ${demoStatus === "failed" ? "bg-red-50 text-red-700" : demoStatus === "succeeded" ? "bg-emerald-50 text-emerald-700" : demoStatus === "running" ? "bg-amber-50 text-amber-700" : "bg-white text-zinc-600"}`}>
                      {demoStatusText[demoStatus]}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="mt-3 rounded-xl"
                      disabled={!referenceFile || !uploadedFile || demoStatus === "running"}
                      onClick={runLocalDemo}
                    >
                      {demoStatus === "running" ? t("image.demoRunningButton") : t("image.runDemo")}
                    </Button>
                  </div>
                </section>
              </aside>
            </div>}
          </div>
        </div>
      </main>
    </div>
  );
}
