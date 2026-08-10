"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { FileImage, Microscope } from "lucide-react";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { MobileWorkspaceDrawer } from "@/components/workspace/MobileWorkspaceDrawer";
import { useLanguage } from "@/lib/i18n";
import { useRouter } from "next/navigation";

interface ExampleImage {
  src: string;
  alt: string;
  label: string;
  result?: "pass" | "review" | "failed";
}

interface ImageExample {
  id: string;
  title: string;
  summary: string;
  description: string;
  rule: string;
  categories: string[];
  reference: ExampleImage;
  uploads: ExampleImage[];
}

const EXAMPLES: ImageExample[] = [
  {
    id: "leaf-spots",
    title: "叶片病斑等级示例",
    summary: "参考图分类 · 叶片病斑",
    description: "使用参考叶片对上传图片中的可见病斑进行等级判断，结果保留人工复核入口。",
    rule: "比较病斑的数量、面积和分布，仅输出有图像依据的类别。",
    categories: ["无明显病斑", "少量病斑", "明显病斑", "待人工复核"],
    reference: { src: "/trait-examples/leaf-reference.svg", alt: "参考叶片", label: "参考图片" },
    uploads: [
      { src: "/trait-examples/leaf-upload-01.svg", alt: "上传叶片一", label: "上传图片 01 · 少量病斑", result: "pass" },
      { src: "/trait-examples/leaf-upload-02.svg", alt: "上传叶片二", label: "上传图片 02 · 明显病斑", result: "review" },
    ],
  },
  {
    id: "sequence",
    title: "图像序列检查示例",
    summary: "参考图分类 · 序列结构",
    description: "用一张结构参考图展示上传文件的视觉序列检查，帮助用户理解规则和结果解释。",
    rule: "检查关键节点是否出现以及顺序是否符合示例规则。",
    categories: ["符合规则", "缺少节点", "顺序异常", "待人工复核"],
    reference: { src: "/trait-examples/sequence-reference.svg", alt: "序列参考图", label: "参考图片" },
    uploads: [
      { src: "/trait-examples/sequence-reference.svg", alt: "上传序列一", label: "上传图片 01 · 符合规则", result: "pass" },
      { src: "/trait-examples/leaf-upload-01.svg", alt: "上传序列二", label: "上传图片 02 · 待复核", result: "review" },
    ],
  },
];

function ExampleList({ selectedId, onSelect }: { selectedId: string; onSelect: (id: string) => void }) {
  const { t } = useLanguage();
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="image-example-list">
      <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">
        <FileImage size={14} />
        <span>{t("image.examplesTitle")}</span>
      </div>
      <div className="mt-2 min-h-0 space-y-1 overflow-y-auto">
        {EXAMPLES.map((example) => (
          <button
            type="button"
            key={example.id}
            className={`w-full rounded-xl px-2.5 py-2.5 text-left transition-colors ${selectedId === example.id ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-900"}`}
            onClick={() => onSelect(example.id)}
            data-testid={`image-example-${example.id}`}
            data-workspace-drawer-dismiss="true"
          >
            <span className="block truncate text-sm font-medium">{example.title}</span>
            <span className={`mt-1 block truncate text-xs ${selectedId === example.id ? "text-zinc-300" : "text-zinc-400"}`}>{example.summary}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ImageJudgePage() {
  const router = useRouter();
  const { t } = useLanguage();
  const [selectedId, setSelectedId] = useState(EXAMPLES[0].id);
  const selected = useMemo(() => EXAMPLES.find((example) => example.id === selectedId) ?? EXAMPLES[0], [selectedId]);

  return (
    <div className="flex h-screen min-h-0 bg-transparent font-sans text-zinc-900">
      <WorkspaceSidebar active="traits" onNavigate={(path) => router.push(path)}>
        <div className="mt-4 min-h-0 flex-1 border-t border-[var(--hairline)] pt-4">
          <ExampleList selectedId={selected.id} onSelect={setSelectedId} />
        </div>
      </WorkspaceSidebar>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-[var(--hairline)] bg-[var(--surface-1)] px-4 backdrop-blur-xl">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-700">
            <MobileWorkspaceDrawer active="traits" onNavigate={(path) => router.push(path)}>
              <ExampleList selectedId={selected.id} onSelect={setSelectedId} />
            </MobileWorkspaceDrawer>
            <Microscope className="h-4 w-4" />
            {t("nav.traits")}
          </div>
        </header>

        <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8">
          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-6 shadow-sm md:p-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs font-medium text-zinc-600">
                  <FileImage className="h-3.5 w-3.5" />
                  {t("image.examplesBadge")}
                </div>
                <h1 className="mt-4 text-3xl font-semibold tracking-tight md:text-4xl">{selected.title}</h1>
                <p className="mt-3 max-w-3xl text-sm leading-7 text-zinc-600">{selected.description}</p>
              </div>
              <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-500">{t("image.compatibilityMode")}</span>
            </div>
          </section>

          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-6 shadow-sm md:p-8" data-testid="reference-images-section">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("image.referenceImages")}</h2>
                <p className="mt-1 text-sm text-zinc-500">{t("image.referenceImagesHint")}</p>
              </div>
              <span className="text-xs uppercase tracking-[0.18em] text-zinc-400">01</span>
            </div>
            <div className="mt-5 overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50">
              <Image src={selected.reference.src} alt={selected.reference.alt} width={960} height={540} className="h-auto w-full" priority />
              <div className="border-t border-zinc-200 px-4 py-3 text-sm font-medium text-zinc-700">{selected.reference.label}</div>
            </div>
          </section>

          <section className="rounded-3xl border border-zinc-200 bg-white/90 p-6 shadow-sm md:p-8" data-testid="uploaded-images-section">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold tracking-tight">{t("image.uploadedImages")}</h2>
                <p className="mt-1 text-sm text-zinc-500">{t("image.uploadedImagesHint")}</p>
              </div>
              <span className="text-xs uppercase tracking-[0.18em] text-zinc-400">{selected.uploads.length.toString().padStart(2, "0")}</span>
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {selected.uploads.map((image) => (
                <figure key={image.label} className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50">
                  <Image src={image.src} alt={image.alt} width={960} height={540} className="h-auto w-full" />
                  <figcaption className="border-t border-zinc-200 px-4 py-3">
                    <div className="text-sm font-medium text-zinc-700">{image.label}</div>
                    <div className={`mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${image.result === "pass" ? "bg-emerald-100 text-emerald-700" : image.result === "failed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                      {t(image.result === "pass" ? "image.resultPass" : image.result === "failed" ? "image.resultFailed" : "image.resultReview" as never)}
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-white/90 p-6 shadow-sm">
              <h2 className="text-base font-semibold">{t("image.analysisDescription")}</h2>
              <p className="mt-3 text-sm leading-7 text-zinc-600">{selected.description}</p>
              <div className="mt-4 rounded-xl bg-zinc-50 px-4 py-3 text-sm leading-6 text-zinc-600"><span className="font-medium text-zinc-800">{t("image.analysisRule")}：</span>{selected.rule}</div>
            </div>
            <div className="rounded-2xl border border-zinc-200 bg-white/90 p-6 shadow-sm">
              <h2 className="text-base font-semibold">{t("image.judgmentCategories")}</h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {selected.categories.map((category) => <span key={category} className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-600">{category}</span>)}
              </div>
              <p className="mt-5 text-xs leading-5 text-zinc-400">{t("image.reviewHint")}</p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
