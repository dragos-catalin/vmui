"use client";

import { RoomGrantsEditor } from "@/components/home/room-grants-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DataTable, sortableHeader, type ColumnDef } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, Panel, Subsection } from "@/components/ui/settings-panel";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAction } from "@/hooks/use-action";
import { err, ok, type ActionResult } from "@/lib/action-result";
import { FAMILY_ROLES, type FamilyRole, type RoomGrants } from "@/lib/home/access-model";
import { ROOMS } from "@/lib/home/catalog";
import { bindDeviceAction, createInviteAction, createMemberAccountAction, removeMemberAction, revokeInviteAction, upsertMemberAction } from "@/server/actions/family";
import { Check, Copy, Laptop, Link2, Pencil, Smartphone, Trash2, Users, X } from "lucide-react";
import * as m from "motion/react-m";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { EASE_OUT } from "./home-motion";

export type InviteRole = Exclude<FamilyRole, "owner">;

export type FamilyMemberView = {
  userId: string;
  email: string;
  displayName: string;
  role: FamilyRole;
  rooms: RoomGrants;
  /** ISO string */
  expiresAt: string | null;
  /** ISO string */
  lastLoginAt: string | null;
  devices: Array<{ id: string; name: string; platform: string; lastSeenAt: string | null }>;
};

export type FamilyInviteView = {
  id: string;
  name: string;
  role: InviteRole;
  rooms: RoomGrants;
  /** ISO string — guest access expiry copied at acceptance */
  accessExpiresAt: string | null;
  /** ISO string — when the link stops working */
  expiresAt: string;
};

export type FamilyCandidate = { id: string; email: string; displayName: string };

export type FamilyCardProps = {
  members: FamilyMemberView[];
  invites: FamilyInviteView[];
  candidates: FamilyCandidate[];
  /** Current user's id — cannot remove themselves. */
  me: string;
  /** `https://host` used to build invite links. */
  origin: string;
};

type T = ReturnType<typeof useTranslations<"family">>;
const INVITE_ROLES: InviteRole[] = ["adult", "child", "guest"];

// datetime-local wants a local wall-clock value without zone; the actions want ISO.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function sameGrants(a: RoomGrants, b: RoomGrants): boolean {
  return ROOMS.every((r) => (a[r.id] ?? "none") === (b[r.id] ?? "none"));
}
function errorText(t: T, error: string): string {
  if (error === "email_taken") return t("errors.emailTaken");
  if (error === "invalid") return t("errors.invalid");
  return t("errors.generic", { message: error });
}
function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length] ?? "x").join("");
}

type FamilyResult<D = unknown> = ({ ok: true } & D) | { ok: false; error: string };

/** useAction over the family actions: their error codes go through `errorText`, success refreshes the page. */
function useFamilyAction<A extends unknown[], D = unknown>(fn: (...args: A) => Promise<FamilyResult<D>>, opts: { success?: string | ((d: D) => string) } = {}) {
  const t = useTranslations("family");
  return useAction<A, D>(
    async (...args: A): Promise<ActionResult<D>> => {
      const r = await fn(...args);
      if (!r.ok) return err(errorText(t, r.error));
      return ok(r as unknown as D) as ActionResult<D>;
    },
    { refresh: true, ...opts },
  );
}

function useConfirmDestructive() {
  const confirm = useConfirm();
  const common = useTranslations("common");
  return (title: string, confirmText: string) => confirm({ title, tone: "danger", confirmText, cancelText: common("cancel") });
}

/** Household access: members with per-room grants, invite links with QR, direct account creation. */
export function FamilyCard({ members, invites, candidates, me, origin }: FamilyCardProps) {
  const t = useTranslations("family");
  const [editing, setEditing] = React.useState<string | null>(null);
  const member = members.find((m) => m.userId === editing) ?? null;
  return (
    <Panel id="family" title={t("title")} description={t("description")}>
      <div className="space-y-4">
        <Subsection title={t("members.title")} hint={t("members.hint")}>
          {members.length === 0 ? (
            <EmptyState compact icon={<Users />} title={t("members.empty")} />
          ) : (
            <>
              <div className="hidden md:block">
                <MembersTable members={members} me={me} onEdit={setEditing} />
              </div>
              <ul className="space-y-2 md:hidden">
                {members.map((m, i) => (
                  <MotionLi key={m.userId} delay={Math.min(i, 8) * 0.035}>
                    <MemberCard member={m} isMe={m.userId === me} onEdit={() => setEditing(m.userId)} />
                  </MotionLi>
                ))}
              </ul>
            </>
          )}
        </Subsection>
        <Sheet open={member !== null} onOpenChange={(o) => { if (!o) setEditing(null); }}>
          {member && (
            <SheetContent title={t("members.editTitle")} description={t("members.editDescription", { name: member.displayName })}>
              <MemberEditor key={`${member.userId}:${member.role}:${JSON.stringify(member.rooms)}:${member.expiresAt ?? ""}:${member.devices.length}`} member={member} isMe={member.userId === me} onDone={() => setEditing(null)} />
            </SheetContent>
          )}
        </Sheet>
        <InviteSection invites={invites} origin={origin} />
        <CreateAccountSection />
        {candidates.length > 0 && <ExistingUserSection candidates={candidates} />}
      </div>
    </Panel>
  );
}

// ---- members

function MotionLi({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <m.li initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_OUT, delay }}>
      {children}
    </m.li>
  );
}

function Avatar({ name }: { name: string }) {
  const initial = (name || "?").trim().charAt(0).toUpperCase();
  return <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklch,var(--color-primary)_18%,transparent)] text-sm font-semibold text-primary">{initial}</span>;
}

function RoleBadge({ role }: { role: FamilyRole }) {
  const t = useTranslations("family.roles");
  const variant = role === "owner" ? "info" : role === "guest" ? "warning" : role === "child" ? "muted" : "default";
  return <Badge variant={variant}>{t(role)}</Badge>;
}

function RoomChips({ role, rooms }: { role: FamilyRole; rooms: RoomGrants }) {
  const t = useTranslations("family");
  const roomNames = useTranslations("home.rooms");
  if (role === "owner") return <span className="text-xs text-muted">{t("members.allRooms")}</span>;
  const ids = ROOMS.filter((r) => rooms[r.id]).map((r) => r.id);
  if (ids.length === 0) return <span className="text-xs text-muted">{t("members.roomsCount", { count: 0 })}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} variant={rooms[id] === "control" ? "success" : "muted"} title={`${roomNames(id)} · ${t(`level.${rooms[id] ?? "view"}`)}`}>
          {roomNames(id)}
        </Badge>
      ))}
    </span>
  );
}

function MembersTable({ members, me, onEdit }: { members: FamilyMemberView[]; me: string; onEdit: (id: string) => void }) {
  const t = useTranslations("family");
  const columns = React.useMemo<ColumnDef<FamilyMemberView, unknown>[]>(
    () => [
      {
        id: "member",
        accessorFn: (m) => `${m.displayName} ${m.email}`,
        header: sortableHeader(t("members.columns.member")),
        cell: ({ row }) => {
          const m = row.original;
          const expired = m.expiresAt !== null && new Date(m.expiresAt).getTime() < Date.now();
          return (
            <span className="flex min-w-0 items-center gap-3">
              <Avatar name={m.displayName || m.email} />
              <span className="min-w-0">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="truncate font-medium">{m.displayName}</span>
                  {m.userId === me && <Badge variant="info">{t("members.you")}</Badge>}
                  {expired && <Badge variant="danger">{t("members.expired")}</Badge>}
                </span>
                <span className="block truncate text-xs text-muted">{m.email}</span>
              </span>
            </span>
          );
        },
      },
      { id: "role", accessorKey: "role", header: sortableHeader(t("members.columns.role")), cell: ({ row }) => <RoleBadge role={row.original.role} /> },
      { id: "rooms", enableSorting: false, header: t("members.columns.rooms"), cell: ({ row }) => <RoomChips role={row.original.role} rooms={row.original.rooms} /> },
      { id: "devices", accessorFn: (m) => m.devices.length, header: sortableHeader(t("members.columns.devices")), cell: ({ row }) => <span className="whitespace-nowrap text-muted">{t("members.devicesCount", { count: row.original.devices.length })}</span> },
      { id: "lastLogin", accessorFn: (m) => (m.lastLoginAt ? new Date(m.lastLoginAt).getTime() : 0), header: sortableHeader(t("members.columns.lastLogin")), cell: ({ row }) => <span className="whitespace-nowrap text-muted">{row.original.lastLoginAt ? ago(t, row.original.lastLoginAt) : t("members.neverLoggedIn")}</span> },
    ],
    [t, me],
  );
  return (
    <DataTable
      columns={columns}
      data={members}
      getRowId={(m) => m.userId}
      searchable={members.length > 5}
      dense
      onRowClick={(m) => onEdit(m.userId)}
      rowActions={(m) => (
        <Button size="sm" variant="ghost" aria-label={t("members.editAria", { name: m.displayName })} onClick={() => onEdit(m.userId)}>
          <Pencil className="size-4" aria-hidden /> <span className="hidden lg:inline">{t("members.edit")}</span>
        </Button>
      )}
    />
  );
}

function MemberCard({ member: m, isMe, onEdit }: { member: FamilyMemberView; isMe: boolean; onEdit: () => void }) {
  const t = useTranslations("family");
  const expired = m.expiresAt !== null && new Date(m.expiresAt).getTime() < Date.now();
  return (
    <button type="button" onClick={onEdit} aria-label={t("members.editAria", { name: m.displayName })} className="surface card-hover flex w-full min-w-0 items-start gap-3 p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <Avatar name={m.displayName || m.email} />
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold">{m.displayName}</span>
          <RoleBadge role={m.role} />
          {isMe && <Badge variant="info">{t("members.you")}</Badge>}
          {expired && <Badge variant="danger">{t("members.expired")}</Badge>}
        </span>
        <span className="block truncate text-xs text-muted">{m.email}</span>
        <RoomChips role={m.role} rooms={m.rooms} />
        <span className="block text-xs text-muted">
          {t("members.devicesCount", { count: m.devices.length })} · {m.lastLoginAt ? t("members.lastLogin", { ago: ago(t, m.lastLoginAt) }) : t("members.neverLoggedIn")}
        </span>
      </span>
      <Pencil className="size-4 shrink-0 text-muted" aria-hidden />
    </button>
  );
}

function MemberEditor({ member, isMe, onDone }: { member: FamilyMemberView; isMe: boolean; onDone: () => void }) {
  const t = useTranslations("family");
  const confirmDestructive = useConfirmDestructive();
  const [role, setRole] = React.useState<FamilyRole>(member.role);
  const [rooms, setRooms] = React.useState<RoomGrants>(member.rooms);
  const [expiresAt, setExpiresAt] = React.useState(toLocalInput(member.expiresAt));
  const [busy, setBusy] = React.useState<"save" | "remove" | string | null>(null);
  const saveAction = useFamilyAction(upsertMemberAction, { success: t("members.saved", { name: member.displayName }) });
  const removeAction = useFamilyAction(removeMemberAction, { success: t("members.removed", { name: member.displayName }) });
  const unbindAction = useFamilyAction(bindDeviceAction);

  const dirty = role !== member.role || !sameGrants(rooms, member.rooms) || expiresAt !== toLocalInput(member.expiresAt);
  const expired = member.expiresAt !== null && new Date(member.expiresAt).getTime() < Date.now();

  const save = async () => {
    setBusy("save");
    const r = await saveAction.run({ userId: member.userId, role, rooms, expiresAt: role === "guest" ? toIso(expiresAt) : null });
    setBusy(null);
    if (r.ok) onDone();
  };
  const remove = async () => {
    if (!(await confirmDestructive(t("members.removeConfirm", { name: member.displayName }), t("members.remove")))) return;
    setBusy("remove");
    const r = await removeAction.run(member.userId);
    setBusy(null);
    if (r.ok) onDone();
  };
  const unbind = async (d: FamilyMemberView["devices"][number]) => {
    setBusy(d.id);
    const r = await unbindAction.run({ deviceId: d.id, userId: null });
    setBusy(null);
    if (r.ok) toast.success(t("devices.unbound", { name: d.name }));
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
        <Avatar name={member.displayName || member.email} />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate text-sm font-semibold">{member.displayName}</span>
            {isMe && <Badge variant="info">{t("members.you")}</Badge>}
            {expired && <Badge variant="danger">{t("members.expired")}</Badge>}
          </div>
          <div className="min-w-0 truncate text-xs text-muted">{member.email}</div>
          <div className="min-w-0 truncate text-xs text-muted">{member.lastLoginAt ? t("members.lastLogin", { ago: ago(t, member.lastLoginAt) }) : t("members.neverLoggedIn")}</div>
        </div>
      </div>

      <div className="grid items-start gap-3">
        <Field label={t("members.role")} hint={t(`roleHints.${role}`)}>
          <RoleSelect value={role} onChange={setRole} roles={FAMILY_ROLES} />
        </Field>
        {role === "guest" && (
          <Field label={t("members.expiresAt")} hint={t("members.expiresHint")}>
            <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </Field>
        )}
      </div>

      {role !== "owner" ? (
        <div className="space-y-1.5">
          <span className="block text-xs text-muted">{t("members.rooms")}</span>
          <RoomGrantsEditor value={rooms} onChange={setRooms} />
        </div>
      ) : (
        <p className="text-xs text-muted">{t("members.allRooms")}</p>
      )}

      <div className="space-y-1.5">
        <span className="block text-xs text-muted">{t("devices.title")}</span>
        {member.devices.length === 0 ? (
          <p className="text-xs text-muted">{t("devices.none")}</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {member.devices.map((d) => (
              <li key={d.id} className="min-w-0 max-w-full">
                <Badge variant="muted" className="max-w-full gap-1 pr-1">
                  <DeviceIcon platform={d.platform} />
                  <span className="min-w-0 truncate">{d.name} · {d.platform}</span>
                  <button
                    type="button"
                    aria-label={t("devices.unbindAria", { name: d.name })}
                    title={t("devices.unbind")}
                    disabled={busy === d.id}
                    onClick={() => void unbind(d)}
                    className="relative grid size-4 shrink-0 place-items-center rounded-full before:absolute before:-inset-1 before:content-[''] hover:bg-[color-mix(in_oklch,var(--color-fg)_12%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" className="shrink-0" aria-label={t("members.removeAria", { name: member.displayName })} disabled={isMe || (busy !== null && busy !== "remove")} loading={busy === "remove"} onClick={() => void remove()}>
          <Trash2 className="size-4" aria-hidden />
          {t("members.remove")}
        </Button>
        <Button size="sm" className="shrink-0" disabled={!dirty || (busy !== null && busy !== "save")} loading={busy === "save"} onClick={() => void save()}>
          <Check className="size-4" aria-hidden />
          {t("members.save")}
        </Button>
      </div>
    </div>
  );
}

function RoleSelect<R extends FamilyRole>({ value, onChange, roles, disabled }: { value: R; onChange: (r: R) => void; roles: readonly R[]; disabled?: boolean }) {
  const t = useTranslations("family.roles");
  const label = useTranslations("family.members");
  return (
    <Select value={value} onValueChange={(v) => onChange(v as R)} disabled={disabled}>
      <SelectTrigger aria-label={label("role")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((r: FamilyRole) => (
          <SelectItem key={r} value={r}>{t(r)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DeviceIcon({ platform }: { platform: string }) {
  return /android|ios|iphone|ipad/i.test(platform) ? <Smartphone className="size-3 shrink-0" aria-hidden /> : <Laptop className="size-3 shrink-0" aria-hidden />;
}

function ago(t: T, iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return t("ago.now");
  if (s < 3600) return t("ago.minutes", { n: Math.round(s / 60) });
  if (s < 86400) return t("ago.hours", { n: Math.round(s / 3600) });
  return t("ago.days", { n: Math.round(s / 86400) });
}

function roomsSummary(t: T, rooms: ReturnType<typeof useTranslations<"home.rooms">>, grants: RoomGrants): string {
  const ids = ROOMS.filter((r) => grants[r.id]).map((r) => r.id);
  if (ids.length === 0) return t("members.roomsCount", { count: 0 });
  return ids.map((id) => `${rooms(id)} (${t(`level.${grants[id] ?? "view"}`)})`).join(", ");
}

// ---- invite by link

function InviteSection({ invites, origin }: { invites: FamilyInviteView[]; origin: string }) {
  const t = useTranslations("family");
  const rooms = useTranslations("home.rooms");
  const fmt = useFormatter();
  const confirmDestructive = useConfirmDestructive();
  const createAction = useFamilyAction(createInviteAction);
  const revokeAction = useFamilyAction(revokeInviteAction, { success: t("invite.revoked") });
  const [name, setName] = React.useState("");
  const [role, setRole] = React.useState<InviteRole>("adult");
  const [grants, setGrants] = React.useState<RoomGrants>({});
  const [expiresAt, setExpiresAt] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<{ url: string; expiresAt: string } | null>(null);
  const [qr, setQr] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!created) return void setQr(null);
    let alive = true;
    // qrcode is only needed once an invite exists: keep it out of the home bundle (HM-35).
    import("qrcode")
      .then((q) => q.default.toDataURL(created.url, { margin: 1, width: 192 }))
      .then((d) => { if (alive) setQr(d); })
      .catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [created]);

  const fmtDate = (iso: string) => fmt.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const daysLeft = (iso: string) => Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("create");
    const r = await createAction.run({ name, role, rooms: grants, accessExpiresAt: role === "guest" ? toIso(expiresAt) : null });
    setBusy(null);
    if (!r.ok || !("data" in r)) return;
    const d = (r.data as { data: { token: string; expiresAt: string } }).data;
    setCreated({ url: `${origin}/invite/${d.token}`, expiresAt: d.expiresAt });
    setCopied(false);
    setName("");
    toast.success(t("invite.created"));
  };
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      toast.success(t("invite.copied"));
    } catch {
      toast.error(t("invite.copyFailed"));
    }
  };
  const revoke = async (inv: FamilyInviteView) => {
    if (!(await confirmDestructive(t("invite.revokeConfirm", { name: inv.name }), t("invite.revoke")))) return;
    setBusy(inv.id);
    await revokeAction.run(inv.id);
    setBusy(null);
  };

  return (
    <Subsection title={t("invite.title")} hint={t("invite.hint")}>
      <form onSubmit={(e) => void create(e)} className="space-y-3">
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label={t("invite.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("invite.namePlaceholder")} maxLength={64} required />
          </Field>
          <Field label={t("members.role")} hint={t(`roleHints.${role}`)}>
            <RoleSelect value={role} onChange={setRole} roles={INVITE_ROLES} />
          </Field>
          {role === "guest" && (
            <Field label={t("members.expiresAt")} hint={t("members.expiresHint")} className="sm:col-span-2">
              <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="space-y-1.5">
          <span className="block text-xs text-muted">{t("members.rooms")}</span>
          <RoomGrantsEditor value={grants} onChange={setGrants} />
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" className="shrink-0" disabled={(busy !== null && busy !== "create") || name.trim().length === 0} loading={busy === "create"}>
            <Link2 className="size-4" aria-hidden />
            {t("invite.create")}
          </Button>
        </div>
      </form>

      {created && (
        <div className="grid items-start gap-3 rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--color-success)_45%,var(--color-border))] bg-[color-mix(in_oklch,var(--color-success)_8%,transparent)] p-3 sm:grid-cols-[auto_minmax(0,1fr)]">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URL generated client-side
            <img src={qr} alt={t("invite.qrAlt")} width={192} height={192} className="mx-auto size-48 rounded-[var(--radius-md)] bg-[oklch(1_0_0)] p-1 sm:mx-0" />
          ) : (
            <Skeleton className="mx-auto size-48 rounded-[var(--radius-md)] sm:mx-0" />
          )}
          <div className="min-w-0 space-y-2">
            <span className="block text-xs text-muted">{t("invite.link")}</span>
            <code className="block min-w-0 break-all rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-xs">{created.url}</code>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="secondary" className="shrink-0" onClick={() => void copy()}>
                {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                {t("invite.copy")}
              </Button>
              <span className="min-w-0 break-words text-xs text-muted">{t("invite.linkExpires", { date: fmtDate(created.expiresAt) })}</span>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <span className="block text-xs text-muted">{t("invite.pending")}</span>
        {invites.length === 0 ? (
          <p className="text-xs text-muted">{t("invite.pendingEmpty")}</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {invites.map((inv) => (
              <li key={inv.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 py-2">
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-sm font-medium">{inv.name}</span>
                    <Badge variant="muted">{t(`roles.${inv.role}`)}</Badge>
                  </div>
                  <div className="min-w-0 break-words text-xs text-muted">{roomsSummary(t, rooms, inv.rooms)}</div>
                  <div className="min-w-0 break-words text-xs text-muted">
                    {[t("invite.expiresIn", { days: daysLeft(inv.expiresAt) }), inv.accessExpiresAt ? t("invite.accessUntil", { date: fmtDate(inv.accessExpiresAt) }) : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="shrink-0" aria-label={t("invite.revokeAria", { name: inv.name })} disabled={busy !== null && busy !== inv.id} loading={busy === inv.id} onClick={() => void revoke(inv)}>
                  <Trash2 className="size-4" aria-hidden />
                  <span className="hidden sm:inline">{t("invite.revoke")}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Subsection>
  );
}

// ---- create account directly

function CreateAccountSection() {
  const t = useTranslations("family");
  const [email, setEmail] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [role, setRole] = React.useState<InviteRole>("child");
  const [grants, setGrants] = React.useState<RoomGrants>({});
  const [expiresAt, setExpiresAt] = React.useState("");
  const createAction = useFamilyAction(createMemberAccountAction, { success: t("create.created", { name: displayName }) });
  const busy = createAction.pending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return void toast.error(t("errors.passwordShort"));
    const r = await createAction.run({ email, displayName, password, role, rooms: grants, expiresAt: role === "guest" ? toIso(expiresAt) : null });
    if (!r.ok) return;
    setEmail("");
    setDisplayName("");
    setPassword("");
    setShowPassword(false);
    setGrants({});
    setExpiresAt("");
  };

  return (
    <Subsection title={t("create.title")} hint={t("create.hint")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label={t("create.displayName")}>
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" maxLength={80} required />
          </Field>
          <Field label={t("create.email")}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" maxLength={200} required />
          </Field>
          <Field label={t("create.password")} hint={showPassword ? t("create.generatedNote") : t("create.passwordHint")}>
            <div className="flex min-w-0 gap-2">
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setShowPassword(false); }}
                autoComplete="new-password"
                minLength={8}
                maxLength={200}
                required
                className={showPassword ? "font-mono" : undefined}
              />
              <Button type="button" size="sm" variant="secondary" className="h-9 shrink-0" onClick={() => { setPassword(generatePassword()); setShowPassword(true); }}>
                {t("create.generate")}
              </Button>
            </div>
          </Field>
          <Field label={t("members.role")} hint={t(`roleHints.${role}`)}>
            <RoleSelect value={role} onChange={setRole} roles={INVITE_ROLES} />
          </Field>
          {role === "guest" && (
            <Field label={t("members.expiresAt")} hint={t("members.expiresHint")} className="sm:col-span-2">
              <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="space-y-1.5">
          <span className="block text-xs text-muted">{t("members.rooms")}</span>
          <RoomGrantsEditor value={grants} onChange={setGrants} />
        </div>
        <div className="flex justify-end">
          <Button type="submit" size="sm" className="shrink-0" loading={busy}>
            <Check className="size-4" aria-hidden />
            {t("create.submit")}
          </Button>
        </div>
      </form>
    </Subsection>
  );
}

// ---- add existing user

function ExistingUserSection({ candidates }: { candidates: FamilyCandidate[] }) {
  const t = useTranslations("family");
  const [userId, setUserId] = React.useState("");
  const [role, setRole] = React.useState<FamilyRole>("adult");
  const [grants, setGrants] = React.useState<RoomGrants>({});
  const [expiresAt, setExpiresAt] = React.useState("");
  const addAction = useFamilyAction(upsertMemberAction);
  const busy = addAction.pending;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = candidates.find((x) => x.id === userId);
    if (!c) return;
    const r = await addAction.run({ userId, role, rooms: grants, expiresAt: role === "guest" ? toIso(expiresAt) : null });
    if (!r.ok) return;
    toast.success(t("existing.added", { name: c.displayName }));
    setUserId("");
    setGrants({});
    setExpiresAt("");
  };

  return (
    <Subsection title={t("existing.title")} hint={t("existing.hint")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label={t("existing.user")}>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger aria-label={t("existing.user")}>
                <SelectValue placeholder={t("existing.pick")} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.displayName} · {c.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("members.role")} hint={t(`roleHints.${role}`)}>
            <RoleSelect value={role} onChange={setRole} roles={FAMILY_ROLES} />
          </Field>
          {role === "guest" && (
            <Field label={t("members.expiresAt")} hint={t("members.expiresHint")} className="sm:col-span-2">
              <Input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          )}
        </div>
        {role !== "owner" && (
          <div className="space-y-1.5">
            <span className="block text-xs text-muted">{t("members.rooms")}</span>
            <RoomGrantsEditor value={grants} onChange={setGrants} />
          </div>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="sm" className="shrink-0" disabled={!userId} loading={busy}>
            <Check className="size-4" aria-hidden />
            {t("existing.add")}
          </Button>
        </div>
      </form>
    </Subsection>
  );
}
