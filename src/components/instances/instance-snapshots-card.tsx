"use client";

import { Alert, Badge, Button, EmptyState, Field, Input, PageSection, SkeletonList } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useAction } from "@/hooks/use-action";
import { err, ok } from "@/lib/action-result";
import {
    createInstanceSnapshotAction,
    deleteInstanceSnapshotAction,
    listInstanceSnapshotsAction,
    restoreInstanceFromSnapshotAction,
    type InstanceSnapshotRow,
} from "@/server/actions/snapshots";
import { Camera, RefreshCw, Rocket, Trash2 } from "lucide-react";
import * as m from "motion/react-m";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

interface Props {
  accountId: string;
  region: string;
  providerInstanceId: string;
  provider: string;
}

const SUPPORTED = new Set(["aws", "azure", "gcp"]);

export function InstanceSnapshotsCard({ accountId, region, providerInstanceId, provider }: Props) {
  const t = useTranslations("vm.snapshots");
  const tc = useTranslations("common");
  const [rows, setRows] = useState<InstanceSnapshotRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [label, setLabel] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const supported = SUPPORTED.has(provider);
  const restoreSupported = provider === "aws" || provider === "azure" || provider === "gcp";
  const confirm = useConfirm();

  const { run: runCreate, pending } = useAction(
    async (trimmed: string) => {
      const r = await createInstanceSnapshotAction({ accountId, region, providerInstanceId, label: trimmed });
      return r.ok ? ok(r.note ? t("createdDetail", { id: r.snapshotId, note: r.note }) : r.snapshotId) : err(r.error);
    },
    { success: (detail) => `${t("created")} — ${detail}`, refresh: false },
  );
  const { run: runDelete } = useAction(
    async (snap: InstanceSnapshotRow) => {
      const r = await deleteInstanceSnapshotAction({ accountId, region: snap.region, snapshotId: snap.externalId });
      return r.ok ? ok() : err(r.error);
    },
    { success: t("deleted"), refresh: false },
  );
  const { run: runRestore } = useAction(
    async (snap: InstanceSnapshotRow, instanceType: string) => {
      const r = await restoreInstanceFromSnapshotAction({
        accountId,
        region: snap.region,
        snapshotId: snap.externalId,
        label: snap.name ?? snap.externalId,
        instanceType,
      });
      return r.ok ? ok(r.providerInstanceId) : err(r.error);
    },
    { success: (id) => `${t("restored")} — ${id}` },
  );

  async function refresh() {
    setRefreshing(true);
    const r = await listInstanceSnapshotsAction({ accountId, region, providerInstanceId });
    setRefreshing(false);
    if (r.ok) setRows(r.rows);
  }

  useEffect(() => {
    if (supported) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, region, providerInstanceId, supported]);

  async function takeSnapshot() {
    const trimmed = label.trim();
    if (!trimmed) return;
    const r = await runCreate(trimmed);
    if (r.ok) {
      setLabel("");
      void refresh();
    }
  }

  async function removeSnapshot(snap: InstanceSnapshotRow) {
    const ok = await confirm({
      title: t("deleteTitle", { name: snap.name ?? snap.externalId }),
      description: t.rich("deleteBody", { b: (c) => <b>{c}</b> }),
      tone: "danger",
      confirmText: tc("delete"),
      requireText: t("typeToConfirm"),
    });
    if (!ok) return;
    setDeletingId(snap.id);
    const r = await runDelete(snap);
    setDeletingId(null);
    if (r.ok) setRows((prev) => (prev ? prev.filter((x) => x.id !== snap.id) : prev));
  }

  async function restoreSnapshot(snap: InstanceSnapshotRow) {
    const defaultType =
      provider === "aws" ? "t3.small" : provider === "azure" ? "Standard_B2s" : "e2-small";
    const ok = await confirm({
      title: t("restoreTitle", { name: snap.name ?? snap.externalId }),
      description: t.rich("restoreBody", { type: defaultType, code: (c) => <code>{c}</code> }),
      tone: "warning",
      confirmText: t("launch"),
    });
    if (!ok) return;
    setRestoringId(snap.id);
    await runRestore(snap, defaultType);
    setRestoringId(null);
  }

  if (!supported) {
    return (
      <PageSection title={t("title")} description={t.rich("unsupported", { provider, code: (c) => <code>{c}</code> })}>
        <EmptyState compact icon={<Camera />} title={t("emptyTitle")} />
      </PageSection>
    );
  }

  const matched = (rows ?? []).filter((r) => r.isLikelyMatch);
  const others = (rows ?? []).filter((r) => !r.isLikelyMatch);

  return (
    <PageSection
      title={t("title")}
      description={t("description")}
      action={
        <Button variant="ghost" size="sm" onClick={refresh} loading={refreshing}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          {tc("refresh")}
        </Button>
      }
    >
      <div className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void takeSnapshot();
          }}
        >
          <Field label={t("label")} className="min-w-48 flex-1">
            <Input
              placeholder={t("labelPlaceholder")}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={pending}
              maxLength={120}
            />
          </Field>
          <Button type="submit" disabled={!label.trim()} loading={pending}>
            <Camera className="h-4 w-4" aria-hidden />
            {t("take")}
          </Button>
        </form>

        {rows == null ? (
          <SkeletonList rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState compact icon={<Camera />} title={t("emptyTitle")} description={t("emptyDescription")} />
        ) : (
          <div className="space-y-3">
            {matched.length > 0 && (
              <SnapshotList
                title={t("likelyMatches")}
                rows={matched}
                muted={false}
                onDelete={removeSnapshot}
                deletingId={deletingId}
                onRestore={restoreSupported ? restoreSnapshot : undefined}
                restoringId={restoringId}
              />
            )}
            {others.length > 0 && (
              <SnapshotList
                title={t("othersIn", { region })}
                subtitle={t("othersHint")}
                rows={others}
                muted
                onDelete={removeSnapshot}
                deletingId={deletingId}
                onRestore={restoreSupported ? restoreSnapshot : undefined}
                restoringId={restoringId}
              />
            )}
            {matched.length === 0 && others.length > 0 && (
              <Alert tone="warning" className="text-[11px]">
                {t("heuristic")}
              </Alert>
            )}
          </div>
        )}
      </div>
    </PageSection>
  );
}

function SnapshotList({
  title,
  subtitle,
  rows,
  muted,
  onDelete,
  deletingId,
  onRestore,
  restoringId,
}: {
  title: string;
  subtitle?: string;
  rows: InstanceSnapshotRow[];
  muted: boolean;
  onDelete: (snap: InstanceSnapshotRow) => void;
  deletingId: string | null;
  onRestore?: (snap: InstanceSnapshotRow) => void;
  restoringId: string | null;
}) {
  const t = useTranslations("vm.snapshots");
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h4 className={`text-xs font-medium ${muted ? "text-muted" : "text-fg"}`}>{title}</h4>
        {subtitle && <span className="text-[11px] text-muted">{subtitle}</span>}
      </div>
      <ul className="divide-y divide-border rounded-[var(--radius-md)] border border-border">
        {rows.map((r, i) => {
          const isDeleting = deletingId === r.id;
          const isRestoring = restoringId === r.id;
          return (
            <m.li
              key={r.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}
              className="flex items-center gap-3 px-3 py-2 text-xs"
            >
              <Camera className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{r.name ?? r.externalId}</div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-muted">{r.externalId}</div>
              </div>
              {r.status && (
                <Badge variant={r.status.toLowerCase().includes("ready") || r.status === "completed" ? "success" : "info"}>
                  {r.status}
                </Badge>
              )}
              {r.sizeBytes != null && (
                <span className="hidden text-[11px] text-muted sm:inline">{formatBytes(r.sizeBytes)}</span>
              )}
              {onRestore && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted hover:text-fg"
                  onClick={() => onRestore(r)}
                  disabled={isDeleting}
                  loading={isRestoring}
                  aria-label={t("restoreHint")}
                  title={t("restoreHint")}
                >
                  <Rocket className="h-3.5 w-3.5" aria-hidden />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="text-muted hover:text-danger"
                onClick={() => onDelete(r)}
                disabled={isRestoring}
                loading={isDeleting}
                aria-label={t("deleteHint")}
                title={t("deleteHint")}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </m.li>
          );
        })}
      </ul>
    </div>
  );
}

function formatBytes(b: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
