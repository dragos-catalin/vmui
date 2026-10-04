"use client";

import { Alert, Badge, Button, Checkbox, DataTable, EmptyState, Field, Input, PageSection, Subsection, ToggleGroup, type ColumnDef, type ToggleOption } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import { isUnrestricted, presetScopes, SCOPE_PRESETS, type ApiKeyScopes, type ScopedToolInfo, type ScopePreset } from "@/lib/api-key-scopes";
import { createApiKeyAction, revokeApiKeyAction } from "@/server/actions/api-keys";
import { Check, Copy, Key, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState, type ReactNode } from "react";
import { toError, toResult } from "./adapt";
import { RelativeTime } from "./relative-time";

export type ApiKeyView = {
  id: string;
  name: string;
  role: "operator" | "viewer";
  rateLimitPerMinute: number;
  createdAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  scopes: ApiKeyScopes | null;
};

export type ScopeCatalog = {
  tools: ScopedToolInfo[];
  vms: Array<{ id: string; label: string; provider: string }>;
  entities: Array<{ id: string; label: string }>;
  pcActions: string[];
};

const ROLES = ["viewer", "operator"] as const;
type PresetChoice = ScopePreset | "custom";
const PRESET_CHOICES: readonly PresetChoice[] = [...SCOPE_PRESETS, "custom"];

const splitIds = (raw: string) => raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

function toggleIn(set: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

function CheckGrid({ items, selected, onToggle, ariaLabel }: { items: Array<{ id: string; label: ReactNode; hint?: ReactNode }>; selected: Set<string>; onToggle: (id: string, on: boolean) => void; ariaLabel: string }) {
  return (
    <div role="group" aria-label={ariaLabel} className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <label key={it.id} className="flex min-h-9 items-center gap-2 rounded-[var(--radius-sm)] px-1.5 text-sm hover:bg-bg-muted">
          <Checkbox checked={selected.has(it.id)} onCheckedChange={(v) => onToggle(it.id, v)} />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate font-mono text-xs">{it.label}</span>
            {it.hint}
          </span>
        </label>
      ))}
    </div>
  );
}

export function ApiKeysManager({ keys, catalog }: { keys: ApiKeyView[]; catalog: ScopeCatalog }) {
  const t = useTranslations("settings.access.apiKeys");
  const tr = useTranslations("auth.roles");
  const format = useFormatter();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"operator" | "viewer">("viewer");
  const [rate, setRate] = useState(60);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [preset, setPreset] = useState<PresetChoice>("all");
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [vmIds, setVmIds] = useState<Set<string>>(new Set());
  const [entities, setEntities] = useState<Set<string>>(new Set());
  const [entityText, setEntityText] = useState("");
  const [pcActions, setPcActions] = useState<Set<string>>(new Set());
  const [scriptText, setScriptText] = useState("");

  const presetOptions = useMemo<ToggleOption<PresetChoice>[]>(
    () => PRESET_CHOICES.map((p) => ({ value: p, label: t(`presets.${p}`) })),
    [t],
  );

  function buildScopes(): ApiKeyScopes | undefined {
    if (role !== "operator") return undefined;
    const base = preset === "custom" ? { tools: [...tools] } : presetScopes(preset, catalog.tools);
    const toolList = base?.tools;
    const entityList = [...new Set([...(base?.entities ?? []), ...entities, ...splitIds(entityText)])];
    const scriptList = [...new Set([...(base?.scripts ?? []), ...splitIds(scriptText)])];
    const scopes: ApiKeyScopes = {
      ...(toolList ? { tools: toolList } : {}),
      ...(vmIds.size ? { vmIds: [...vmIds] } : {}),
      ...(entityList.length ? { entities: entityList } : {}),
      ...(pcActions.size ? { pcActions: [...pcActions] } : {}),
      ...(scriptList.length ? { scripts: scriptList } : {}),
    };
    return isUnrestricted(scopes) ? undefined : scopes;
  }

  function resetScopes() {
    setPreset("all");
    setTools(new Set());
    setVmIds(new Set());
    setEntities(new Set());
    setEntityText("");
    setPcActions(new Set());
    setScriptText("");
  }

  const create = useAction(
    async (): Promise<ActionResult<string>> => {
      const r = await createApiKeyAction({ name: name.trim(), role, rateLimitPerMinute: rate, scopes: buildScopes() });
      return r.ok ? ok(r.plaintext) : toError(r);
    },
    {
      success: t("created"),
      onSuccess: (plaintext) => {
        setIssued(plaintext);
        setName("");
        resetScopes();
      },
    },
  );

  const revoke = useAction(async (id: string) => toResult(await revokeApiKeyAction(id)), { success: t("revoked") });

  async function onRevoke(k: ApiKeyView) {
    const yes = await confirm({
      title: t("confirmRevoke", { name: k.name }),
      description: t("confirmRevokeHint"),
      tone: "danger",
      confirmText: t("revoke"),
    });
    if (yes) await revoke.run(k.id);
  }

  const copy = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const columns = useMemo<ColumnDef<ApiKeyView, unknown>[]>(() => {
    const scopeSummary = (s: ApiKeyScopes | null) => {
      if (isUnrestricted(s)) return <Badge variant="muted">{t("unrestricted")}</Badge>;
      const parts: string[] = [];
      if (s?.tools) parts.push(t("scopeSummary.tools", { count: s.tools.length }));
      if (s?.vmIds) parts.push(t("scopeSummary.vms", { count: s.vmIds.length }));
      if (s?.entities) parts.push(t("scopeSummary.entities", { count: s.entities.length }));
      if (s?.pcActions) parts.push(t("scopeSummary.pc", { count: s.pcActions.length }));
      if (s?.scripts) parts.push(t("scopeSummary.scripts", { count: s.scripts.length }));
      return <Badge variant="info">{parts.join(" · ")}</Badge>;
    };
    return [
      { accessorKey: "name", header: t("columns.name"), cell: ({ row }) => <span className="font-medium">{row.original.name}</span> },
      {
        accessorKey: "role",
        header: t("columns.role"),
        cell: ({ row }) => <Badge variant={row.original.role === "operator" ? "info" : "muted"}>{tr(row.original.role)}</Badge>,
      },
      {
        id: "scopes",
        accessorFn: (k) => (isUnrestricted(k.scopes) ? "" : "scoped"),
        header: t("columns.scopes"),
        cell: ({ row }) => (row.original.role === "operator" ? scopeSummary(row.original.scopes) : <span className="text-fg-muted">—</span>),
      },
      {
        accessorKey: "rateLimitPerMinute",
        header: t("columns.rate"),
        cell: ({ row }) => <span className="tabular-nums text-fg-muted">{t("perMinute", { n: row.original.rateLimitPerMinute })}</span>,
      },
      {
        accessorKey: "createdAt",
        header: t("columns.created"),
        cell: ({ row }) => <span className="whitespace-nowrap text-fg-muted">{format.dateTime(new Date(row.original.createdAt), { dateStyle: "medium" })}</span>,
      },
      {
        accessorKey: "lastUsedAt",
        header: t("columns.lastUsed"),
        cell: ({ row }) =>
          row.original.lastUsedAt ? (
            <RelativeTime date={row.original.lastUsedAt} className="whitespace-nowrap text-fg-muted" />
          ) : (
            <span className="text-fg-muted">{t("neverUsed")}</span>
          ),
      },
      {
        id: "status",
        accessorFn: (k) => (k.revokedAt ? "revoked" : "active"),
        header: t("columns.status"),
        cell: ({ row }) =>
          row.original.revokedAt ? <Badge variant="danger">{t("revokedBadge")}</Badge> : <Badge variant="success">{t("active")}</Badge>,
      },
    ];
  }, [t, tr, format]);

  const toolItems = catalog.tools.map((tool) => ({
    id: tool.name,
    label: tool.name,
    hint: tool.destructive ? <Badge variant="danger">{t("destructive")}</Badge> : tool.readOnly ? <Badge variant="muted">{t("readOnly")}</Badge> : null,
  }));

  return (
    <div className="space-y-4">
      {issued && (
        <Alert
          tone="success"
          title={t("issuedTitle")}
          action={
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              {t("dismiss")}
            </Button>
          }
        >
          <p>{t("issuedHint")}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 font-mono text-xs">{issued}</code>
            <Button size="icon" variant="outline" onClick={() => void copy()} aria-label={t("copy")}>
              {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            </Button>
          </div>
        </Alert>
      )}

      <PageSection title={t("createTitle")} description={t("createDescription")}>
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_8rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create.run();
          }}
        >
          <Field label={t("name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} required />
          </Field>
          <Field label={t("role")}>
            <Select value={role} onValueChange={(v) => setRole(v as "operator" | "viewer")}>
              <SelectTrigger aria-label={t("role")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {tr(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("rateLimit")} hint={t("rateLimitHint")}>
            <Input
              type="number"
              min={1}
              max={10000}
              value={rate}
              onChange={(e) => setRate(Number.parseInt(e.target.value, 10) || 60)}
              className="tabular-nums"
            />
          </Field>
          <Button type="submit" loading={create.pending} disabled={!name.trim()}>
            <Plus className="size-4" aria-hidden /> {t("create")}
          </Button>

          {role === "operator" && (
            <div className="space-y-3 sm:col-span-4">
              <Field label={t("scopes")} hint={t("scopesHint")}>
                <ToggleGroup value={preset} onValueChange={setPreset} options={presetOptions} size="sm" aria-label={t("scopes")} />
              </Field>

              {preset === "stream" && <p className="text-xs text-fg-muted">{t("presetHints.stream")}</p>}

              {preset === "custom" && (
                <Subsection title={t("scopeTools")} collapsible>
                  <CheckGrid items={toolItems} selected={tools} onToggle={(id, on) => setTools((s) => toggleIn(s, id, on))} ariaLabel={t("scopeTools")} />
                </Subsection>
              )}

              {catalog.vms.length > 0 && (
                <Subsection title={t("scopeVms")} collapsible defaultOpen={false}>
                  <CheckGrid
                    items={catalog.vms.map((v) => ({ id: v.id, label: v.label, hint: <Badge variant="muted">{v.provider}</Badge> }))}
                    selected={vmIds}
                    onToggle={(id, on) => setVmIds((s) => toggleIn(s, id, on))}
                    ariaLabel={t("scopeVms")}
                  />
                </Subsection>
              )}

              <Subsection title={t("scopeEntities")} hint={t("scopeEntitiesHint")} collapsible defaultOpen={false}>
                {catalog.entities.length > 0 && (
                  <CheckGrid
                    items={catalog.entities.map((e) => ({ id: e.id, label: e.id, hint: <span className="truncate text-xs text-fg-muted">{e.label}</span> }))}
                    selected={entities}
                    onToggle={(id, on) => setEntities((s) => toggleIn(s, id, on))}
                    ariaLabel={t("scopeEntities")}
                  />
                )}
                <Input value={entityText} onChange={(e) => setEntityText(e.target.value)} placeholder="light.moodlight, climate.bedroom_ac" className="font-mono text-xs" aria-label={t("scopeEntities")} />
              </Subsection>

              <Subsection title={t("scopePcActions")} collapsible defaultOpen={false}>
                <CheckGrid
                  items={catalog.pcActions.map((a) => ({ id: a, label: a }))}
                  selected={pcActions}
                  onToggle={(id, on) => setPcActions((s) => toggleIn(s, id, on))}
                  ariaLabel={t("scopePcActions")}
                />
              </Subsection>

              <Field label={t("scopeScripts")} hint={t("scopeScriptsHint")}>
                <Input value={scriptText} onChange={(e) => setScriptText(e.target.value)} placeholder="movie_mode_on, copilot_done" className="font-mono text-xs" />
              </Field>
            </div>
          )}
        </form>
      </PageSection>

      <PageSection title={t("title")} description={t("count", { count: keys.length })}>
        <DataTable
          columns={columns}
          data={keys}
          dense
          searchable={keys.length > 5}
          getRowId={(k) => k.id}
          emptyState={<EmptyState compact icon={<Key />} title={t("empty")} description={t("emptyHint")} />}
          rowActions={(k) =>
            k.revokedAt ? null : (
              <Button size="icon" variant="ghost" onClick={() => void onRevoke(k)} disabled={revoke.pending} aria-label={t("revoke")}>
                <Trash2 className="size-4 text-danger" aria-hidden />
              </Button>
            )
          }
        />
      </PageSection>
    </div>
  );
}
