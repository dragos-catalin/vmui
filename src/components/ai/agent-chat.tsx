"use client";

import { LogViewer } from "@/components/ops/log-viewer";
import { Alert, Badge, Button, EmptyState, PageHeader, PageSection, PageShell, Skeleton, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { askAgentAction, checkOllamaAction } from "@/server/actions/ai";
import { Bot, ChevronDown, Eraser, RefreshCw, Send, User, Wrench } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as Mo from "motion/react-m";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";

interface UiMsg {
  role: "user" | "assistant" | "tool";
  content: string;
  tool?: string;
}

type Status = { ok: boolean; url: string; model: string; error?: string };

const SUGGESTIONS = ["idle", "lastHour", "cost", "recommend"] as const;

export function AgentChat() {
  const t = useTranslations("ops.ai");
  const tc = useTranslations("common");
  const [msgs, setMsgs] = useState<UiMsg[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [pending, start] = useTransition();
  const listRef = useRef<HTMLDivElement | null>(null);

  const check = async () => {
    setChecking(true);
    try {
      setStatus(await checkOllamaAction());
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    void check();
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs.length, pending]);

  const send = (text?: string) => {
    const message = (text ?? input).trim();
    if (!message) return;
    setInput("");
    const userMsg: UiMsg = { role: "user", content: message };
    setMsgs((m) => [...m, userMsg]);
    start(async () => {
      const history = msgs.map((m) => ({ role: m.role, content: m.content, tool_name: m.tool }));
      const r = await askAgentAction({ message, history });
      if (!r.ok) {
        setMsgs((m) => [...m, { role: "assistant", content: t("errorPrefix", { error: r.error }) }]);
        return;
      }
      const newOnes = r.messages.slice(history.length + 1) as UiMsg[];
      setMsgs((m) => [...m, ...newOnes.map((x) => ({ ...x, tool: x.tool }))]);
    });
  };

  return (
    <PageShell width="narrow">
      <PageHeader
        title={t("title")}
        description={t.rich("description", { code: (chunks) => <code className="rounded bg-surface-2 px-1 font-mono text-xs">{chunks}</code> })}
        icon={<Bot />}
        badge={
          status ? (
            <Badge variant={status.ok ? "success" : "danger"} dot={status.ok}>
              {status.ok ? t("status.online") : t("status.offline")}
            </Badge>
          ) : (
            <Skeleton className="h-5 w-16 rounded-full" />
          )
        }
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => void check()} loading={checking}>
              <RefreshCw className="size-4" aria-hidden />
              {t("status.recheck")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMsgs([])} disabled={msgs.length === 0 || pending}>
              <Eraser className="size-4" aria-hidden />
              {tc("clear")}
            </Button>
          </>
        }
      />

      {status && !status.ok && (
        <Alert tone="danger" title={t("status.unreachable", { url: status.url })}>
          {status.error}
        </Alert>
      )}
      {status?.ok && (
        <p className="text-xs text-fg-muted">
          {t("status.connected", { url: status.url, model: status.model })}
        </p>
      )}

      <PageSection title={t("conversation")} description={t("conversationHint")} className="flex flex-col">
        <div ref={listRef} className="flex max-h-[60vh] min-h-[40vh] flex-col gap-3 overflow-y-auto rounded-[var(--radius-lg)] bg-bg-muted/40 p-3 [scrollbar-width:thin]" role="log" aria-live="polite">
          {msgs.length === 0 && !pending ? (
            <EmptyState
              compact
              icon={<Bot />}
              title={t("empty.title")}
              description={t("empty.description")}
              action={SUGGESTIONS.map((s) => (
                <Button key={s} size="sm" variant="secondary" onClick={() => send(t(`suggestions.${s}`))} disabled={!status?.ok}>
                  {t(`suggestions.${s}`)}
                </Button>
              ))}
            />
          ) : null}
          <AnimatePresence initial={false}>
            {msgs.map((m, i) => (
              <Mo.div key={i} initial={{ y: 6 }} animate={{ y: 0 }} transition={{ duration: 0.2 }}>
                <Bubble m={m} />
              </Mo.div>
            ))}
          </AnimatePresence>
          {pending && (
            <div className="flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
              <span className="pulse-dot inline-block size-2 rounded-full bg-primary" aria-hidden />
              {t("thinking")}
            </div>
          )}
        </div>

        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={t("placeholder")}
            aria-label={t("placeholder")}
            rows={2}
            className="min-h-11 flex-1 resize-none"
            disabled={pending}
          />
          <Button type="submit" loading={pending} disabled={!input.trim()} className="min-h-11 sm:min-h-9">
            <Send className="size-4" aria-hidden />
            {t("send")}
          </Button>
        </form>
        <p className="mt-1.5 text-[11px] text-fg-soft">{t("hint")}</p>
      </PageSection>
    </PageShell>
  );
}

function Bubble({ m }: { m: UiMsg }) {
  const t = useTranslations("ops.ai");
  if (m.role === "tool") return <ToolResult m={m} />;
  const isUser = m.role === "user";
  const Icon = isUser ? User : Bot;
  return (
    <div className={cn("flex gap-2", isUser && "justify-end")}>
      {!isUser && (
        <span className="mt-1 grid size-7 shrink-0 place-items-center rounded-full bg-bg-muted text-primary" aria-hidden>
          <Icon className="size-4" />
        </span>
      )}
      <div
        className={cn(
          "max-w-[85%] min-w-0 rounded-[var(--radius-lg)] px-3 py-2 text-sm",
          isUser ? "bg-primary text-primary-fg" : "surface",
        )}
      >
        <span className="sr-only">{isUser ? t("roles.user") : t("roles.assistant")}</span>
        <p className="whitespace-pre-wrap break-words">{m.content}</p>
      </div>
    </div>
  );
}

function ToolResult({ m }: { m: UiMsg }) {
  const t = useTranslations("ops.ai");
  const [open, setOpen] = useState(false);
  const lines = m.content.split("\n").length;
  return (
    <div className="surface max-w-[95%] min-w-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Wrench className="size-3.5 shrink-0 text-warning" aria-hidden />
        <span className="font-medium">{t("toolCall", { tool: m.tool ?? "tool" })}</span>
        <Badge variant="muted" className="ml-auto">
          {t("toolLines", { count: lines })}
        </Badge>
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && <LogViewer text={m.content} height="max-h-64" searchable={lines > 20} autoScroll={false} wrap className="rounded-none border-0 border-t" />}
    </div>
  );
}
