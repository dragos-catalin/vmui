"use client";

import { Badge, Button, EmptyState, Field, Input } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useAction } from "@/hooks/use-action";
import type { ActionResult } from "@/lib/action-result";
import type { AlertChannelRow } from "@/lib/db/schema";
import { createAlertChannelAction, deleteAlertChannelAction, testAlertChannelAction } from "@/server/actions/alerts";
import { Bell, Hash, Mail, MessageCircle, Plus, Send, Trash2, Webhook } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import * as React from "react";

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  toast: Bell,
  discord: MessageCircle,
  slack: Hash,
  ntfy: Bell,
  webhook: Webhook,
  smtp: Mail,
};

type Kind = "toast" | "discord" | "slack" | "ntfy" | "webhook" | "smtp";
const KINDS: Kind[] = ["toast", "discord", "slack", "ntfy", "webhook", "smtp"];
type FieldKey = "webhookUrl" | "username" | "channel" | "baseUrl" | "topic" | "token" | "url" | "hmacSecret" | "host" | "port" | "password" | "from" | "to";

const wrap =
  <A extends unknown[]>(fn: (...a: A) => Promise<{ ok: boolean; error?: string }>) =>
  async (...a: A): Promise<ActionResult> => {
    const r = await fn(...a);
    return r.ok ? { ok: true } : { ok: false, error: r.error ?? "common.error" };
  };

export function AlertChannelsPanel({ channels }: { channels: AlertChannelRow[] }) {
  const t = useTranslations("observe.alerts.channels");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<Kind>("discord");
  const [name, setName] = React.useState("");
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const setF = (k: string, v: string) => setFields((s) => ({ ...s, [k]: v }));
  const [testingId, setTestingId] = React.useState<string | null>(null);

  const create = useAction(wrap(createAlertChannelAction), {
    success: t("created"),
    onSuccess: () => {
      setOpen(false);
      setName("");
      setFields({});
    },
  });
  const remove = useAction(wrap(deleteAlertChannelAction), { success: tc("delete") });
  const test = useAction(wrap(testAlertChannelAction), { success: t("testSent"), refresh: false });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    let channel: Parameters<typeof createAlertChannelAction>[0]["channel"];
    switch (kind) {
      case "toast":
        channel = { kind: "toast" };
        break;
      case "discord":
        channel = { kind: "discord", webhookUrl: fields.webhookUrl ?? "", username: fields.username || undefined };
        break;
      case "slack":
        channel = { kind: "slack", webhookUrl: fields.webhookUrl ?? "", channel: fields.channel || undefined };
        break;
      case "ntfy":
        channel = { kind: "ntfy", baseUrl: fields.baseUrl || "https://ntfy.sh", topic: fields.topic ?? "", token: fields.token || undefined };
        break;
      case "webhook":
        channel = { kind: "webhook", url: fields.url ?? "", hmacSecret: fields.hmacSecret || undefined };
        break;
      case "smtp":
        channel = {
          kind: "smtp",
          host: fields.host ?? "",
          port: Number(fields.port ?? "587"),
          secure: fields.secure === "true",
          username: fields.username || undefined,
          password: fields.password || undefined,
          from: fields.from ?? "",
          to: fields.to ?? "",
        };
        break;
    }
    void create.run({ name, channel });
  };

  const text = (key: FieldKey, opts?: { required?: boolean; type?: string; placeholder?: string }) => (
    <Field label={t(`fields.${key}`)} key={key}>
      <Input
        type={opts?.type ?? "text"}
        value={fields[key] ?? ""}
        onChange={(e) => setF(key, e.target.value)}
        required={opts?.required}
        placeholder={opts?.placeholder}
        autoComplete={opts?.type === "password" ? "off" : undefined}
      />
    </Field>
  );

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="size-4" aria-hidden /> {t("add")}
        </Button>
      </div>

      {channels.length === 0 ? (
        <EmptyState
          compact
          icon={<Bell />}
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-4" aria-hidden /> {t("add")}
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-border">
          <AnimatePresence initial={false}>
            {channels.map((c, i) => {
              const Icon = KIND_ICON[c.kind] ?? Bell;
              return (
                <m.li
                  key={c.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
                  className="flex flex-wrap items-center gap-3 py-2"
                >
                  <Icon className="size-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.name}</span>
                  <Badge variant="muted">{t(`kind.${c.kind as Kind}`)}</Badge>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={testingId === c.id && test.pending}
                      onClick={async () => {
                        setTestingId(c.id);
                        await test.run({ id: c.id });
                        setTestingId(null);
                      }}
                    >
                      <Send className="size-3.5" aria-hidden /> {tc("test")}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={tc("delete")}
                      className="text-danger"
                      onClick={async () => {
                        if (!(await confirm({ title: t("confirmDelete", { name: c.name }), tone: "danger", confirmText: tc("delete") }))) return;
                        void remove.run({ id: c.id });
                      }}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                </m.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent title={t("sheet.title")} description={t("sheet.description")}>
          <form onSubmit={submit} className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("fields.name")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={64} />
              </Field>
              <Field label={t("fields.kind")}>
                <Select value={kind} onValueChange={(v) => setKind(v as Kind)}>
                  <SelectTrigger aria-label={t("fields.kind")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {t(`kind.${k}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {kind === "discord" && (
              <>
                {text("webhookUrl", { required: true, type: "url" })}
                {text("username")}
              </>
            )}
            {kind === "slack" && (
              <>
                {text("webhookUrl", { required: true, type: "url" })}
                {text("channel")}
              </>
            )}
            {kind === "ntfy" && (
              <>
                {text("baseUrl", { type: "url", placeholder: "https://ntfy.sh" })}
                {text("topic", { required: true })}
                {text("token", { type: "password" })}
              </>
            )}
            {kind === "webhook" && (
              <>
                {text("url", { required: true, type: "url" })}
                {text("hmacSecret", { type: "password" })}
              </>
            )}
            {kind === "smtp" && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {text("host", { required: true })}
                  {text("port", { required: true, type: "number", placeholder: "587" })}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {text("username")}
                  {text("password", { type: "password" })}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {text("from", { required: true, type: "email" })}
                  {text("to", { required: true, type: "email" })}
                </div>
              </>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {tc("cancel")}
              </Button>
              <Button type="submit" loading={create.pending}>
                {tc("save")}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
