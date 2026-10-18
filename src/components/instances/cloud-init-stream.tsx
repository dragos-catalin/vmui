"use client";

import { Alert, Badge, Button, PageSection } from "@/components/ui";
import { useEventSource } from "@/hooks/use-poll";
import { Play, Square, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

interface LogLine {
  ts: number;
  text: string;
}

interface Props {
  instanceId: string;
  platform: string;
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function classify(line: string): string {
  if (/error|fail|denied/i.test(line)) return "text-danger";
  if (/warn/i.test(line)) return "text-warning";
  if (/success|done|ready|finished/i.test(line)) return "text-success";
  return "text-fg-soft";
}

type Status = "idle" | "connecting" | "streaming" | "error" | "ended";
type ErrorKind = "streamError" | "connectionClosed";

export function CloudInitStream({ instanceId, platform }: Props) {
  const t = useTranslations("vm.cloudInit");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<{ kind: ErrorKind; message?: string } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const done = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const supported = platform === "linux" || platform === "macos";

  useEffect(() => {
    if (!scrollerRef.current) return;
    scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
  }, [lines.length]);

  // One-shot stream: the server ends it with `end`, or with a named `error`
  // carrying { message }; neither should reconnect, so both clear the url.
  useEventSource<{ ts?: number; text?: string; message?: string }>(url, {
    events: ["hello", "line", "end", "error"],
    onMessage: (d, event) => {
      if (event === "hello") setStatus("streaming");
      else if (event === "line" && typeof d.text === "string") {
        const line = { ts: d.ts ?? Date.now(), text: stripAnsi(d.text) };
        setLines((prev) => {
          const next = prev.concat(line);
          return next.length > 2000 ? next.slice(-2000) : next;
        });
      } else if (event === "end") {
        done.current = true;
        setStatus("ended");
        setUrl(null);
      } else if (event === "error") {
        done.current = true;
        setError({ kind: "streamError", message: d.message });
        setStatus("error");
        setUrl(null);
      }
    },
    onError: () => {
      if (done.current) return;
      done.current = true;
      setError((e) => e ?? { kind: "connectionClosed" });
      setStatus("error");
      setUrl(null);
    },
  });

  const start = () => {
    if (!supported) return;
    setError(null);
    setStatus("connecting");
    done.current = false;
    setUrl(`/api/instances/${encodeURIComponent(instanceId)}/cloud-init/stream`);
  };

  const stop = () => {
    setUrl(null);
    setStatus("idle");
  };

  const active = status === "streaming" || status === "connecting";

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        <>
          <Badge variant={status === "streaming" ? "success" : status === "error" ? "danger" : "muted"} dot={status === "streaming"}>
            {t(`status.${status}`)}
          </Badge>
          {active ? (
            <Button size="sm" variant="ghost" onClick={stop} loading={status === "connecting"}>
              <Square className="h-3.5 w-3.5" aria-hidden /> {t("stop")}
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={!supported}>
              <Play className="h-3.5 w-3.5" aria-hidden /> {lines.length > 0 ? t("resume") : t("stream")}
            </Button>
          )}
          {lines.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setLines([])} aria-label={t("clear")} title={t("clear")}>
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </Button>
          )}
        </>
      }
    >
      {!supported ? (
        <Alert tone="info" className="text-xs">
          {t("unsupported")}
        </Alert>
      ) : (
        <div className="space-y-2">
          {error && (
            <Alert tone="danger" className="text-xs">
              {error.message ?? t(error.kind)}
            </Alert>
          )}
          <div
            ref={scrollerRef}
            role="log"
            aria-live="polite"
            className="max-h-[420px] overflow-y-auto rounded-[var(--radius-md)] border border-border bg-surface-muted p-2 font-mono text-[11px] leading-tight"
          >
            {lines.length === 0 ? (
              <div className="grid place-items-center py-8 text-xs text-muted">
                {t.rich("hint", { code: (c) => <code>{c}</code> })}
              </div>
            ) : (
              lines.map((l, i) => (
                <div key={i} className={classify(l.text)}>
                  {l.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </PageSection>
  );
}
