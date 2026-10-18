import { AlertTriangle, CloudOff, RotateCcw } from "lucide-react";
import * as m from "motion/react-m";
import * as React from "react";
import { useTranslation } from "react-i18next";
import i18n from "./i18n";
import { cn } from "./lib";
import { swatchName } from "./lights";

export function Card({ title, sub, right, children, className }: { title?: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("glass p-5", className)}>
      {(title || right) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold break-words">{title}</h2>}
            {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-border last:border-0">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5 break-words">{hint}</div>}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

export function Slider({ value, min, max, step = 1, onChange, onCommit, format }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; onCommit?: (v: number) => void; format?: (v: number) => string }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-3 w-full">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ "--v": `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
      <span className="w-14 text-right text-xs tabular-nums text-muted">{format ? format(value) : value}</span>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string; icon?: React.ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-xl p-1 gap-1 bg-bg-2 border border-border">
      {options.map((o) => (
        <button key={o.id} type="button" onClick={() => onChange(o.id)} aria-pressed={o.id === value}
          className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm transition-colors", o.id === value ? "bg-surface-2 text-fg border-border" : "border-transparent text-muted hover:text-fg")}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "ok" | "warn" | "down" }) {
  return (
    <div className="glass px-4 py-3">
      <div className="text-xs text-muted">{k}</div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", tone === "ok" && "text-ok", tone === "warn" && "text-warn", tone === "down" && "text-down")}>{v}</div>
    </div>
  );
}

export function Swatches({ value, onChange, colors }: { value: string; onChange: (hex: string) => void; colors: string[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {colors.map((c) => (
        <button key={c} type="button" aria-label={swatchName(c)} title={swatchName(c)} aria-pressed={value.toLowerCase() === c.toLowerCase()} onClick={() => onChange(c)}
          className={cn("size-7 rounded-full border-2 transition-transform", value.toLowerCase() === c.toLowerCase() ? "border-fg scale-110" : "border-transparent hover:scale-105")} style={{ background: c }} />
      ))}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-8 w-10 rounded-lg border border-border bg-transparent p-0.5" aria-label={t("common.customColor")} />
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab inside `ref`, focuses the first control (or `initial`), Escape calls onClose, focus returns on unmount. */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onClose: () => void, initial?: React.RefObject<HTMLElement | null>) {
  const close = React.useRef(onClose);
  close.current = onClose;
  React.useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const root = ref.current;
    (initial?.current ?? root?.querySelector<HTMLElement>(FOCUSABLE) ?? root)?.focus();
    const k = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.stopPropagation(); close.current(); return; }
      if (ev.key !== "Tab" || !root) return;
      const list = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (list.length === 0) { ev.preventDefault(); return; }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (ev.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", k, true);
    return () => { window.removeEventListener("keydown", k, true); prev?.focus?.(); };
  }, [ref, initial]);
}

/** Modal dialog: focus trapped inside, Escape and backdrop close it, focus returns on close. */
export function Dialog({ title, sub, onClose, children, width = 520, initialFocus }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode; width?: number; initialFocus?: React.RefObject<HTMLElement | null> }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useFocusTrap(ref, onClose, initialFocus);
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] grid place-items-center bg-scrim p-4" onClick={onClose}>
      <m.div ref={ref} tabIndex={-1} className="glass float max-h-[90vh] w-full overflow-y-auto p-5 outline-none" style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onClick={(ev) => ev.stopPropagation()} initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}>
        <h3 id={titleId} className="text-lg font-semibold break-words">{title}</h3>
        {sub && <p className="mb-4 mt-0.5 text-xs text-muted">{sub}</p>}
        {children}
      </m.div>
    </div>
  );
}

type ConfirmOpts = { title: string; body?: string; confirm?: string; danger?: boolean };
const confirmSubs = new Set<(r: (ConfirmOpts & { resolve: (ok: boolean) => void }) | null) => void>();

/** Styled replacement for window.confirm(): `if (await confirmDialog({ title, danger: true })) …`. Needs <ConfirmHost/> mounted once. */
export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  if (confirmSubs.size === 0) return Promise.resolve(window.confirm(opts.title));
  return new Promise((resolve) => confirmSubs.forEach((s) => s({ ...opts, resolve })));
}

export function ConfirmHost() {
  const { t } = useTranslation();
  const [req, setReq] = React.useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { confirmSubs.add(setReq); return () => void confirmSubs.delete(setReq); }, []);
  if (!req) return null;
  const done = (ok: boolean) => { req.resolve(ok); setReq(null); };
  return (
    <Dialog title={req.title} onClose={() => done(false)} width={420} initialFocus={req.danger ? cancelRef : undefined}>
      {req.body && <p className="mt-2 text-sm text-muted">{req.body}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button ref={cancelRef} type="button" className="btn ghost" onClick={() => done(false)}>{t("common.cancel")}</button>
        <button type="button" className={cn("btn", req.danger ? "danger solid" : "primary")} onClick={() => done(true)}>{req.confirm ?? t("common.confirm")}</button>
      </div>
    </Dialog>
  );
}

/** One header for every page: title (+ sub) left, actions right, wrapping on narrow windows. */
export function PageHeader({ title, sub, actions, level = 1 }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; level?: 1 | 2 }) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <H className={cn("font-semibold tracking-tight", level === 1 ? "text-2xl" : "text-lg")}>{title}</H>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** "Showing older data" marker for a poll whose last refresh failed. */
export function StaleBadge({ error }: { error: string | null }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-warn/50 px-2 py-0.5 text-xs text-warning-text" title={error ?? undefined} role="status">
      <CloudOff className="size-3" aria-hidden />{t("common.stale")}
    </span>
  );
}

/* ------------------------------------------------------------- empty states */

export type EmptyIllustration = "vms" | "lights" | "devices" | "offline" | "search" | "notifications" | "generic";

function Puffs({ x, y, delay = 0.25 }: { x: number; y: number; delay?: number }) {
  const puffs = [{ dx: 0, dy: 0, r: 2.2, o: 0.9 }, { dx: 3, dy: -6, r: 1.8, o: 0.65 }, { dx: 0.5, dy: -11.5, r: 1.4, o: 0.4 }];
  return (
    <g>
      {puffs.map((p, i) => (
        <m.circle key={i} cx={x + p.dx} cy={y + p.dy} r={p.r} fill="currentColor" stroke="none" initial={{ opacity: 0, y: 3 }} animate={{ opacity: p.o, y: 0 }}
          transition={{ duration: 0.9, delay: delay + i * 0.14, ease: [0.16, 1, 0.3, 1] }} />
      ))}
    </g>
  );
}
const FLAME = "M0 0c-2.4-2-3.2-4.2-1.6-7 .6 1.4 1.6 1.8 2.2.6.4-1.4.2-2.6 1-3.6 1.6 2.6 2.8 5.2 1.6 7.8C2.6-.8 1.4 0 0 0Z";
const Flame = ({ x, y, faded = false }: { x: number; y: number; faded?: boolean }) => <path d={FLAME} transform={`translate(${x} ${y})`} fill="var(--color-primary)" stroke="none" opacity={faded ? 0.35 : 0.9} />;
const Roof = ({ dashed = false }: { dashed?: boolean }) => <path d="M14 38 48 12l12 9.2V14h7v12.6L82 38" strokeDasharray={dashed ? "3 4" : undefined} />;

/** Same art as the web app's empty-illustrations.tsx (roofline, chimney, flame, smoke). */
const ART: Record<EmptyIllustration, React.ReactNode> = {
  generic: <><Roof /><path d="M22 34v26h52V34" /><Flame x={47} y={58} /><Puffs x={63.5} y={9} /></>,
  vms: (
    <>
      <rect x="26" y="20" width="44" height="12" rx="3" /><rect x="26" y="36" width="44" height="12" rx="3" /><rect x="26" y="52" width="44" height="12" rx="3" />
      <path d="M32 26h6M32 42h6M32 58h6" /><path d="M58 20v-6h6v6" />
      <circle cx="63" cy="26" r="1" fill="var(--color-lit)" stroke="none" /><circle cx="63" cy="42" r="1" fill="var(--color-lit)" stroke="none" />
      <Puffs x={61} y={9} />
    </>
  ),
  lights: (
    <>
      <path d="M48 22a13 13 0 0 0-8 23.2c1.6 1.3 2.5 3.1 2.5 5.1V53h11v-2.7c0-2 .9-3.8 2.5-5.1A13 13 0 0 0 48 22Z" />
      <path d="M43 58h10M44.5 62h7" /><path d="M45 43c0-3 1.5-4 3-6 1.5 2 3 3 3 6" stroke="var(--color-primary)" />
      <Puffs x={34} y={20} delay={0.2} /><Puffs x={62} y={20} delay={0.35} />
    </>
  ),
  devices: <><path d="M12 34 48 8l14 10.1V12h6v10.4L84 34" /><rect x="24" y="36" width="30" height="24" rx="3" /><rect x="60" y="38" width="13" height="22" rx="3" /><path d="M37 56h4M65 56h3" /><Puffs x={65} y={7} /></>,
  offline: <><Roof dashed /><path d="M22 34v26h52V34" opacity={0.7} /><Flame x={47} y={58} faded /><path d="M40 44l16 0" opacity={0.5} strokeDasharray="2 3" /></>,
  search: <><circle cx="42" cy="36" r="16" /><path d="M53.5 47.5 66 60" strokeWidth={3} /><path d="M62 56v-8h6v14" /><Puffs x={65} y={42} /><path d="M34 36a8 8 0 0 1 8-8" opacity={0.6} /></>,
  notifications: <><path d="M48 16a14 14 0 0 0-14 14v10l-5 8h38l-5-8V30a14 14 0 0 0-14-14Z" /><path d="M43 52a5 5 0 0 0 10 0" /><Puffs x={68} y={24} /></>,
};

export function EmptyArt({ kind, className }: { kind: EmptyIllustration; className?: string }) {
  return (
    <svg viewBox="0 0 96 72" width={96} height={72} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden focusable="false">
      {ART[kind]}
    </svg>
  );
}

/** Empty / offline state with the line illustration, an optional hint and action. */
export function EmptyState({ title, hint, illustration = "generic", action, compact }: { title: string; hint?: string; illustration?: EmptyIllustration; action?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={cn("grid justify-items-center gap-2 rounded-xl border border-dashed border-border text-center", compact ? "p-4" : "p-8")} role="status">
      <EmptyArt kind={illustration} className="text-muted" />
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="max-w-sm text-xs text-muted">{hint}</div>}
      {action}
    </div>
  );
}

export function Empty({ text, illustration }: { text: string; illustration?: EmptyIllustration }) {
  return <EmptyState title={text} illustration={illustration} compact />;
}

/** Loading line used while a page's first read is in flight. */
export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return <div className="text-sm text-muted" role="status" aria-live="polite">{label ?? t("common.loading")}</div>;
}

/** Error with retry, for a failed first read. */
export function ErrorState({ title, error, onRetry }: { title: string; error?: string | null; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="grid justify-items-center gap-2 rounded-xl border border-dashed border-down/50 p-6 text-center" role="alert">
      <EmptyArt kind="offline" className="text-muted" />
      <div className="text-sm font-medium">{title}</div>
      {error && <div className="max-w-md break-words text-xs text-muted">{error}</div>}
      {onRetry && <button type="button" className="btn sm" onClick={onRetry}><RotateCcw className="size-3.5" />{t("common.retry")}</button>}
    </div>
  );
}

/* ----------------------------------------------------------- error boundary */

type EBProps = { children: React.ReactNode; scope?: string };
/** Catches a render crash so one page cannot blank the whole window; Retry remounts the subtree. */
export class ErrorBoundary extends React.Component<EBProps, { error: Error | null; key: number }> {
  state = { error: null as Error | null, key: 0 };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`[${this.props.scope ?? "app"}]`, error); }
  render() {
    if (!this.state.error) return <React.Fragment key={this.state.key}>{this.props.children}</React.Fragment>;
    return (
      <div className="grid place-items-center p-8">
        <div className="glass grid max-w-md justify-items-center gap-3 p-6 text-center" role="alert">
          <AlertTriangle className="size-7 text-down" aria-hidden />
          <div className="font-semibold">{i18n.isInitialized ? i18n.t("error.title") : "Something went wrong"}</div>
          <div className="break-words text-xs text-muted">{this.state.error.message}</div>
          <button type="button" className="btn primary sm" onClick={() => this.setState((s) => ({ error: null, key: s.key + 1 }))}>
            <RotateCcw className="size-3.5" />{i18n.isInitialized ? i18n.t("common.retry") : "Retry"}
          </button>
        </div>
      </div>
    );
  }
}
