import { Button } from "@/components/ui/button";
import { SendHorizontal, Square } from "lucide-react";
import { type FormEvent, type RefObject } from "react";
import { useLanguage } from "@/lib/i18n";

interface ComposerProps {
  input: string;
  isLoading: boolean;
  inlineError: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onInputChange: (value: string) => void;
  onSubmit: (event?: FormEvent) => void;
  onStop: () => void;
  onRetry: () => void;
  onDismissError: () => void;
  unauthenticated?: boolean;
}

export function Composer({
  input,
  isLoading,
  inlineError,
  inputRef,
  onInputChange,
  onSubmit,
  onStop,
  onRetry,
  onDismissError,
  unauthenticated = false,
}: ComposerProps) {
  const { t } = useLanguage();
  return (
    <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-white via-white/95 to-transparent pt-10 print:hidden">
      <div className="max-w-3xl mx-auto px-4 pb-8">
        {inlineError && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex items-center justify-between gap-3">
            <span>{inlineError}</span>
            <div className="flex items-center gap-2 shrink-0">
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t("composer.retry")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onDismissError}>
                {t("composer.dismiss")}
              </Button>
            </div>
          </div>
        )}
        <form onSubmit={onSubmit} className="relative group">
          <div className="relative flex items-center">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => {
                onInputChange(e.target.value);
                e.currentTarget.style.height = "auto";
                e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 220)}px`;
              }}
              onKeyDown={(e) => {
                if ((e.nativeEvent as KeyboardEvent).isComposing || e.keyCode === 229) {
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSubmit(e);
                }
              }}
              placeholder={unauthenticated ? t("composer.signInPlaceholder") : t("composer.messagePlaceholder")}
              className="w-full bg-white/95 border border-[var(--hairline-strong)] rounded-2xl py-4 pl-4 pr-12 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] transition-all duration-150 ease-[var(--easing-standard)] resize-none shadow-sm"
            />
            <Button
              type={isLoading ? "button" : "submit"}
              size="icon"
              disabled={!isLoading && !input.trim()}
              onClick={isLoading ? onStop : undefined}
              className={`absolute right-2 top-1/2 -translate-y-1/2 h-9 w-9 rounded-xl transition-all duration-150 ease-[var(--easing-standard)] active:scale-95 ${isLoading ? "!bg-zinc-900 hover:!bg-zinc-800" : "!bg-zinc-700 hover:!bg-zinc-900"} disabled:!bg-zinc-200`}
            >
              {isLoading ? <Square className="h-4 w-4 text-white" /> : <SendHorizontal className="h-4 w-4 text-white" />}
            </Button>
          </div>
          <p className="text-[11px] text-center text-zinc-400 mt-3">{t("composer.disclaimer")}</p>
        </form>
      </div>
    </div>
  );
}
