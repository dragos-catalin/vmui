"use client";

import { Badge, Button, DataTable, EmptyState, PageSection, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import { deleteSshKeyAction } from "@/server/actions/ssh-keys";
import { Check, Copy, Key, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toResult } from "./adapt";

interface KeyRow {
  id: string;
  name: string;
  algo: string;
  publicKey: string;
  fingerprint: string | null;
  hasPrivateKey: boolean;
  notes: string | null;
  createdAt: Date;
}

export function SshKeyList({ keys }: { keys: KeyRow[] }) {
  const t = useTranslations("settings.access.sshKeys");
  const tc = useTranslations("common");
  const format = useFormatter();
  const confirm = useConfirm();
  const [copied, setCopied] = useState<string | null>(null);

  const remove = useAction(async (id: string) => toResult(await deleteSshKeyAction(id)), { success: t("deleted") });

  async function onRemove(k: KeyRow) {
    const yes = await confirm({
      title: t("confirmDelete", { name: k.name }),
      description: t("confirmDeleteHint"),
      tone: "danger",
      confirmText: tc("delete"),
    });
    if (yes) await remove.run(k.id);
  }

  async function copyKey(k: KeyRow) {
    await navigator.clipboard.writeText(k.publicKey);
    setCopied(k.id);
    setTimeout(() => setCopied(null), 1200);
  }

  const columns = useMemo<ColumnDef<KeyRow, unknown>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("columns.name"),
        cell: ({ row }) => (
          <div className="min-w-0">
            <span className="block truncate font-medium" title={row.original.name}>{row.original.name}</span>
            {row.original.notes && <span className="block truncate text-xs text-fg-muted" title={row.original.notes}>{row.original.notes}</span>}
          </div>
        ),
      },
      { accessorKey: "algo", header: t("columns.algo"), cell: ({ row }) => <Badge variant="info">{row.original.algo}</Badge> },
      {
        id: "material",
        accessorFn: (k) => (k.hasPrivateKey ? "private" : "public"),
        header: t("columns.material"),
        cell: ({ row }) =>
          row.original.hasPrivateKey ? <Badge variant="success">{t("private")}</Badge> : <Badge variant="muted">{t("publicOnly")}</Badge>,
      },
      {
        accessorKey: "fingerprint",
        header: t("columns.fingerprint"),
        enableSorting: false,
        cell: ({ row }) => (
          <code className="block max-w-[16rem] truncate font-mono text-xs text-fg-muted" title={row.original.fingerprint ?? undefined}>
            {row.original.fingerprint ?? "—"}
          </code>
        ),
      },
      {
        accessorKey: "createdAt",
        header: t("columns.created"),
        cell: ({ row }) => <span className="whitespace-nowrap text-fg-muted">{format.dateTime(new Date(row.original.createdAt), { dateStyle: "medium" })}</span>,
      },
    ],
    [t, format],
  );

  return (
    <PageSection title={t("savedTitle")} description={t("count", { count: keys.length })}>
      <DataTable
        columns={columns}
        data={keys}
        dense
        searchable={keys.length > 5}
        getRowId={(k) => k.id}
        emptyState={<EmptyState compact icon={<Key />} title={t("empty")} description={t("emptyHint")} />}
        rowActions={(k) => (
          <>
            <Button size="icon" variant="ghost" onClick={() => void copyKey(k)} aria-label={t("copyPublic")}>
              {copied === k.id ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            </Button>
            <Button size="icon" variant="ghost" onClick={() => void onRemove(k)} disabled={remove.pending} aria-label={t("delete")}>
              <Trash2 className="size-4 text-danger" aria-hidden />
            </Button>
          </>
        )}
      />
    </PageSection>
  );
}
