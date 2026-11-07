"use client";

import { Alert, Badge, Button } from "@/components/ui";
import { getAiConsentAction, setAiConsentAction } from "@/server/actions/ai-consent";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

type State = Awaited<ReturnType<typeof getAiConsentAction>>;

/** First-use AI disclosure (AI Act art. 50(1)) + per-user consent with an off switch.
 *  The server refuses the chat without it (askAgentAction); this only explains and records. */
export function useAiConsent() {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => {
    void getAiConsentAction().then(setState);
  }, []);
  return [state, setState] as const;
}

export function AiConsentPanel({ state, onChange }: { state: State | null; onChange: (s: State) => void }) {
  const t = useTranslations("legal.ai");
  const [pending, start] = useTransition();
  if (!state) return null;

  const set = (granted: boolean) =>
    start(async () => {
      const r = await setAiConsentAction({ granted });
      if (!r.ok) return;
      onChange({ ...state, granted: r.granted, at: Date.now() });
      toast.success(granted ? t("turnedOn") : t("turnedOff"));
    });

  if (state.granted) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <Badge variant="info">
          <Sparkles className="size-3" aria-hidden /> {t("badge")}
        </Badge>
        <span>{t("consentIntro")}</span>
        <Button size="sm" variant="ghost" onClick={() => set(false)} loading={pending}>
          {t("turnOff")}
        </Button>
        <Link href="/privacy" className="underline underline-offset-4">
          {t("privacy")}
        </Link>
      </div>
    );
  }

  return (
    <Alert
      tone="info"
      icon={<Sparkles />}
      title={t("consentTitle")}
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => set(true)} loading={pending}>
            {t("accept")}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link href="/privacy">{t("privacy")}</Link>
          </Button>
        </div>
      }
    >
      <div className="space-y-1.5">
        <p>{t("consentIntro")}</p>
        <p>{t("consentSent")}</p>
        <p className="font-mono text-xs">{t("consentRoute", { route: state.route })}</p>
        <p>{t("consentCoach")}</p>
        <p>{t("consentOff")}</p>
      </div>
    </Alert>
  );
}
