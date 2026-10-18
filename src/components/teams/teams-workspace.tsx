"use client";

import { Alert, Badge, Button, DataTable, EmptyState, Field, Input, PageSection, sortableHeader, type ColumnDef } from "@/components/ui";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { ok, type ActionResult } from "@/lib/action-result";
import type { TeamWithMembers } from "@/lib/teams";
import { createTeamAction, inviteToTeamAction, removeMemberAction, setMemberRoleAction } from "@/server/actions/teams";
import { Check, Copy, Plus, UserPlus, Users, X } from "lucide-react";
import * as Mo from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";

type Member = TeamWithMembers["members"][number];
type Role = "admin" | "operator" | "viewer" | "member";
const ROLES: readonly Role[] = ["member", "viewer", "operator", "admin"];
const ROLE_VARIANT: Record<string, "info" | "success" | "warning" | "muted" | "default"> = {
  owner: "success",
  admin: "warning",
  operator: "info",
  viewer: "muted",
  member: "default",
};

export function TeamsWorkspace({ teams }: { teams: TeamWithMembers[] }) {
  const t = useTranslations("govern.teams");
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");

  const create = useAction(
    async (): Promise<ActionResult> => {
      const r = await createTeamAction({ name: name.trim(), slug });
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    {
      success: t("toast.created"),
      onSuccess: () => {
        setName("");
        setSlug("");
      },
    },
  );

  return (
    <div className="space-y-4">
      <PageSection title={t("create.title")}>
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && slug) void create.run();
          }}
        >
          <Field label={t("create.name")}>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, ""));
              }}
              placeholder={t("create.namePlaceholder")}
              required
            />
          </Field>
          <Field label={t("create.slug")}>
            <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder={t("create.slugPlaceholder")} className="font-mono" required />
          </Field>
          <Button type="submit" loading={create.pending} disabled={!name.trim() || !slug}>
            <Plus className="size-4" aria-hidden /> {t("create.submit")}
          </Button>
        </form>
      </PageSection>

      {teams.length === 0 ? (
        <EmptyState icon={<Users />} title={t("empty.title")} description={t("empty.description")} />
      ) : (
        teams.map((team, i) => (
          <Mo.div key={team.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.03 }}>
            <TeamCard team={team} />
          </Mo.div>
        ))
      )}
    </div>
  );
}

function TeamCard({ team }: { team: TeamWithMembers }) {
  const t = useTranslations("govern.teams");
  const format = useFormatter();
  const confirm = useConfirm();
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const remove = useAction(
    async (m: Member): Promise<ActionResult> => {
      const r = await removeMemberAction({ teamId: team.id, userId: m.userId });
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    { success: t("toast.removed") },
  );
  const setRole = useAction(
    async (m: Member, role: Role): Promise<ActionResult> => {
      const r = await setMemberRoleAction({ teamId: team.id, userId: m.userId, role });
      return r.ok ? ok() : { ok: false, error: r.error };
    },
    { success: t("toast.roleChanged") },
  );

  async function onRemove(m: Member) {
    const yes = await confirm({ title: t("confirmRemove.title", { name: m.displayName }), description: t("confirmRemove.description"), tone: "danger", confirmText: t("confirmRemove.confirm") });
    if (yes) await remove.run(m);
  }

  const columns = React.useMemo<ColumnDef<Member, unknown>[]>(
    () => [
      {
        accessorKey: "displayName",
        header: sortableHeader(t("members.columns.member")),
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.displayName}</p>
            <p className="truncate text-xs text-fg-muted">{row.original.email}</p>
          </div>
        ),
      },
      {
        accessorKey: "role",
        header: sortableHeader(t("members.columns.role")),
        cell: ({ row }) => {
          const m = row.original;
          if (m.role === "owner") return <Badge variant="success">{t("roles.owner")}</Badge>;
          return (
            <Select value={m.role} onValueChange={(v) => void setRole.run(m, v as Role)} disabled={setRole.pending}>
              <SelectTrigger aria-label={t("members.roleLabel", { name: m.displayName })} className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`roles.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        },
      },
      {
        accessorKey: "joinedAt",
        header: sortableHeader(t("members.columns.joined")),
        cell: ({ row }) => <span className="whitespace-nowrap text-fg-muted">{format.dateTime(new Date(row.original.joinedAt), { dateStyle: "medium" })}</span>,
      },
    ],
    [t, format, setRole],
  );

  const pending = team.invitations.filter((i) => !i.accepted);

  return (
    <PageSection
      title={
        <span className="flex flex-wrap items-center gap-2">
          {team.name}
          <code className="font-mono text-xs font-normal text-fg-muted">{team.slug}</code>
        </span>
      }
      description={t("members.count", { count: team.members.length })}
      action={
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-4" aria-hidden /> {t("invite.open")}
        </Button>
      }
    >
      <div className="space-y-4">
        <DataTable
          columns={columns}
          data={team.members}
          dense
          getRowId={(m) => m.userId}
          emptyState={<EmptyState compact icon={<Users />} title={t("members.empty.title")} description={t("members.empty.description")} />}
          rowActions={(m) =>
            m.role === "owner" ? null : (
              <Button size="icon" variant="ghost" aria-label={t("members.remove", { name: m.displayName })} onClick={() => void onRemove(m)} disabled={remove.pending}>
                <X className="size-4 text-danger" aria-hidden />
              </Button>
            )
          }
        />

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-muted">{t("invitations.title")}</h3>
          {pending.length === 0 ? (
            <p className="text-sm text-fg-muted">{t("invitations.empty")}</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {pending.map((inv) => (
                <li key={inv.id} className="flex min-w-0 items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border bg-surface-muted px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{inv.email}</span>
                    <span className="block text-xs text-fg-muted">{t("invitations.expires", { date: format.dateTime(new Date(inv.expiresAt), { dateStyle: "medium" }) })}</span>
                  </span>
                  <Badge variant={ROLE_VARIANT[inv.role] ?? "default"}>{t(`roles.${inv.role as Role}`)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <InviteDialog team={team} open={inviteOpen} onOpenChange={setInviteOpen} />
    </PageSection>
  );
}

function InviteDialog({ team, open, onOpenChange }: { team: TeamWithMembers; open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations("govern.teams");
  const tc = useTranslations("common");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("member");
  const [link, setLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const invite = useAction(
    async (): Promise<ActionResult<string>> => {
      const r = await inviteToTeamAction({ teamId: team.id, email: email.trim(), role });
      return r.ok ? ok(r.token) : { ok: false, error: r.error };
    },
    {
      success: t("toast.invited"),
      onSuccess: (token) => {
        setLink(`${window.location.origin}/teams/accept?token=${token}`);
        setEmail("");
      },
    },
  );

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setLink(null);
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) void invite.run();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("invite.title", { team: team.name })}</DialogTitle>
            <DialogDescription>{t("invite.description")}</DialogDescription>
          </DialogHeader>
          {link ? (
            <Alert tone="success" title={t("invite.linkTitle")}>
              <p>{t("invite.linkHint")}</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-[var(--radius-sm)] bg-surface-2 px-2 py-1 font-mono text-xs text-fg">{link}</code>
                <Button type="button" size="icon" variant="outline" onClick={() => void copy()} aria-label={t("invite.copy")}>
                  {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                </Button>
              </div>
            </Alert>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <Field label={t("invite.email")}>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("invite.emailPlaceholder")} autoComplete="off" required />
              </Field>
              <Field label={t("invite.role")}>
                <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                  <SelectTrigger aria-label={t("invite.role")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {link ? tc("close") : tc("cancel")}
            </Button>
            {!link && (
              <Button type="submit" loading={invite.pending} disabled={!email.trim()}>
                <UserPlus className="size-4" aria-hidden /> {t("invite.submit")}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
