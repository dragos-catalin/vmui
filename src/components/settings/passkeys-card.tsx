"use client";

import { Button, DataTable, EmptyState, Field, Input, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import {
    deletePasskeyAction,
    finishPasskeyRegistrationAction,
    listPasskeysAction,
    startPasskeyRegistrationAction,
    type PasskeySummary,
} from "@/server/actions/passkeys";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { Fingerprint, KeyRound, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { toResult } from "./adapt";
import { RelativeTime } from "./relative-time";

export function PasskeysCard() {
  const t = useTranslations("settings.security.passkeys");
  const tc = useTranslations("common");
  const confirm = useConfirm();
  const [rows, setRows] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    setRows(await listPasskeysAction());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useAction(async (id: string) => toResult(await deletePasskeyAction(id)), {
    success: t("removed"),
    refresh: false,
    onSuccess: () => void refresh(),
  });

  async function add() {
    setAdding(true);
    try {
      const init = await startPasskeyRegistrationAction();
      if (!init.ok) {
        toast.error(init.error);
        return;
      }
      const response = await startRegistration({
        optionsJSON: init.options as PublicKeyCredentialCreationOptionsJSON,
      });
      const r = await finishPasskeyRegistrationAction({
        challengeKey: init.challengeKey,
        label: label.trim() || t("defaultLabel"),
        response,
      });
      if (r.ok) {
        toast.success(t("added"));
        setLabel("");
        await refresh();
      } else {
        toast.error(r.error ?? tc("failed"));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg && !/cancel/i.test(msg) && !/AbortError/.test(msg)) {
        toast.error(msg);
      }
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(p: PasskeySummary) {
    const ok = await confirm({
      title: t("confirmRemove", { label: p.label }),
      description: t("confirmRemoveHint"),
      tone: "danger",
      confirmText: tc("remove"),
    });
    if (ok) await remove.run(p.id);
  }

  const columns = useMemo<ColumnDef<PasskeySummary, unknown>[]>(
    () => [
      {
        accessorKey: "label",
        header: t("label"),
        cell: ({ row }) => (
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <KeyRound className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
            <span className="truncate" title={row.original.label}>{row.original.label}</span>
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: t("addedAt"),
        cell: ({ row }) => <RelativeTime date={row.original.createdAt} className="whitespace-nowrap text-fg-muted" />,
      },
      {
        accessorKey: "lastUsedAt",
        header: t("lastUsed"),
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <RelativeTime date={row.original.lastUsedAt} className="whitespace-nowrap text-fg-muted" />
          ) : (
            <span className="text-fg-muted">{t("never")}</span>
          ),
      },
    ],
    [t],
  );

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        data={rows}
        loading={loading}
        dense
        getRowId={(r) => r.id}
        emptyState={<EmptyState compact icon={<Fingerprint />} title={t("empty")} description={t("emptyHint")} />}
        rowActions={(p) => (
          <Button size="icon" variant="ghost" onClick={() => void onRemove(p)} disabled={remove.pending} aria-label={t("remove")}>
            <Trash2 className="size-4 text-danger" aria-hidden />
          </Button>
        )}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Field label={t("label")} className="flex-1">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("labelPlaceholder")} maxLength={60} disabled={adding} />
        </Field>
        <Button onClick={() => void add()} loading={adding} className="sm:mb-0">
          <Fingerprint className="size-4" aria-hidden /> {t("add")}
        </Button>
      </div>
    </div>
  );
}
