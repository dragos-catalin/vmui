"use client";

import { startNavProgress } from "@/components/nav/nav-progress";
import { Mic, MicOff, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type SpeechRec = (typeof globalThis & { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown });

interface SRInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: (e: SREvent) => void;
  onerror: (e: { error: string }) => void;
  onend: () => void;
}
interface SREvent { results: { 0: { transcript: string }; isFinal: boolean }[] }

type CommandKey =
  | "dashboard" | "instances" | "newVm" | "accounts" | "costs" | "forecast" | "anomalies" | "recordings"
  | "runbooks" | "budgets" | "autoPark" | "keyRotation" | "digest" | "mesh" | "ai" | "dr" | "restore"
  | "status" | "teams" | "settings";

// Phrases are matched against the lowercased transcript; the recogniser runs in
// the UI locale, so both English and Romanian forms are listed.
const COMMANDS: { phrases: string[]; href: string; key: CommandKey }[] = [
  { phrases: ["dashboard", "home", "panou", "acasă"], href: "/", key: "dashboard" },
  { phrases: ["instances", "vms", "machines", "servers", "instanțe", "mașini", "servere"], href: "/instances", key: "instances" },
  { phrases: ["new vm", "new instance", "launch", "create vm", "vm nou", "instanță nouă"], href: "/instances/new", key: "newVm" },
  { phrases: ["accounts", "providers", "conturi", "furnizori"], href: "/accounts", key: "accounts" },
  { phrases: ["costs", "billing", "costuri", "facturare"], href: "/costs", key: "costs" },
  { phrases: ["forecast", "projection", "prognoză", "proiecție"], href: "/forecast", key: "forecast" },
  { phrases: ["anomaly", "anomalies", "anomalii"], href: "/anomalies", key: "anomalies" },
  { phrases: ["recordings", "asciinema", "replay", "înregistrări"], href: "/recordings", key: "recordings" },
  { phrases: ["runbook", "runbooks"], href: "/runbooks", key: "runbooks" },
  { phrases: ["budget", "budgets", "buget", "bugete"], href: "/budgets", key: "budgets" },
  { phrases: ["auto park", "park", "parcare"], href: "/auto-park", key: "autoPark" },
  { phrases: ["key rotation", "rotate keys", "rotire chei"], href: "/key-rotation", key: "keyRotation" },
  { phrases: ["digest", "what changed", "rezumat", "ce s-a schimbat"], href: "/digest", key: "digest" },
  { phrases: ["mesh", "wireguard"], href: "/mesh", key: "mesh" },
  { phrases: ["ai agent", "ai", "chat"], href: "/ai", key: "ai" },
  { phrases: ["disaster recovery", "dr drill", "exercițiu dr"], href: "/dr", key: "dr" },
  { phrases: ["restore", "restaurare"], href: "/restore", key: "restore" },
  { phrases: ["status", "stare"], href: "/status", key: "status" },
  { phrases: ["teams", "echipe"], href: "/teams", key: "teams" },
  { phrases: ["settings", "setări"], href: "/settings", key: "settings" },
];

export function VoiceCommander() {
  const t = useTranslations("misc.voice");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const recRef = useRef<SRInstance | null>(null);
  const router = useRouter();

  useEffect(() => {
    const w = globalThis as SpeechRec;
    setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const start = () => {
    const w = globalThis as SpeechRec;
    const Ctor = (w.SpeechRecognition || w.webkitSpeechRecognition) as new () => SRInstance;
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = locale === "ro" ? "ro-RO" : "en-US";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      if (!last) return;
      const text = last[0].transcript.trim().toLowerCase();
      setTranscript(text);
      if (last.isFinal) match(text);
    };
    r.onerror = (e) => toast.error(t("error", { error: e.error }));
    r.onend = () => setListening(false);
    r.start();
    recRef.current = r;
    setListening(true);
    setTranscript("");
  };
  const stop = () => { try { recRef.current?.stop(); } catch { /* noop */ } setListening(false); };

  const match = (text: string) => {
    let best: { score: number; cmd: typeof COMMANDS[number] } | null = null;
    for (const c of COMMANDS) {
      for (const p of c.phrases) {
        if (text.includes(p)) {
          const score = p.length;
          if (!best || score > best.score) best = { score, cmd: c };
        }
      }
    }
    if (best) {
      toast.success(t("goingTo", { label: t(`commands.${best.cmd.key}`) }));
      startNavProgress(best.cmd.href);
      router.push(best.cmd.href);
      setOpen(false);
    } else {
      toast.message(t("noMatch", { text }));
    }
  };

  if (!open) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[var(--z-toast)] flex justify-center px-4 sm:bottom-8">
      <div role="region" aria-label={t("hint")} className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full border border-border bg-surface p-2 shadow-[var(--shadow-lg)]">
        {!supported ? (
          <span className="px-3 text-sm text-fg-muted">{t("unsupported")}</span>
        ) : (
          <>
            <button
              type="button"
              onClick={listening ? stop : start}
              aria-pressed={listening}
              className={`flex size-10 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${listening ? "bg-danger text-danger-fg motion-safe:animate-pulse" : "bg-primary text-primary-fg"}`}
              aria-label={listening ? t("stop") : t("start")}
            >
              {listening ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
            </button>
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted" aria-live="polite">
              {listening ? (transcript || t("listening")) : t("hint")}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={() => { stop(); setOpen(false); }}
          aria-label={t("close")}
          className="flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
