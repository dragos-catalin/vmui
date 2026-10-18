import "server-only";
import { createTransport, type Transporter } from "nodemailer";

export type ChannelKind = "toast" | "discord" | "slack" | "ntfy" | "webhook" | "smtp";

export interface DiscordConfig {
  webhookUrl: string;
  username?: string;
}
export interface SlackConfig {
  webhookUrl: string;
  channel?: string;
}
export interface NtfyConfig {
  baseUrl: string;
  topic: string;
  token?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
}
export interface WebhookConfig {
  url: string;
  /** Optional HMAC secret (hex). Sent as `X-Vmui-Signature: sha256=…`. */
  hmacSecret?: string;
  headers?: Record<string, string>;
}
export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  username?: string;
  password?: string;
  from: string;
  to: string;
}
export interface ToastConfig {
  /** Browsers handle this; server-side delivery just emits an event. */
  level?: "info" | "warning" | "critical";
}

export type ChannelConfig =
  | { kind: "toast"; config: ToastConfig }
  | { kind: "discord"; config: DiscordConfig }
  | { kind: "slack"; config: SlackConfig }
  | { kind: "ntfy"; config: NtfyConfig }
  | { kind: "webhook"; config: WebhookConfig }
  | { kind: "smtp"; config: SmtpConfig };

export interface AlertPayload {
  ruleName: string;
  severity: "info" | "warning" | "critical";
  message: string;
  metric: string;
  value: number;
  threshold: number;
  instanceId?: string | null;
  instanceName?: string | null;
  firedAt: number;
}

export interface DeliveryResult {
  ok: boolean;
  channelKind: ChannelKind;
  channelName: string;
  error?: string;
}

async function deliverDiscord(cfg: DiscordConfig, p: AlertPayload): Promise<void> {
  const color = p.severity === "critical" ? 0xff4444 : p.severity === "warning" ? 0xffaa33 : 0x33aaff;
  const res = await fetch(cfg.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: cfg.username ?? "Vatra",
      embeds: [
        {
          title: `[${p.severity.toUpperCase()}] ${p.ruleName}`,
          description: p.message,
          color,
          fields: [
            { name: "Metric", value: p.metric, inline: true },
            { name: "Value", value: String(p.value), inline: true },
            { name: "Threshold", value: String(p.threshold), inline: true },
            ...(p.instanceName ? [{ name: "Instance", value: p.instanceName, inline: false }] : []),
          ],
          timestamp: new Date(p.firedAt).toISOString(),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text().catch(() => "")}`);
}

async function deliverSlack(cfg: SlackConfig, p: AlertPayload): Promise<void> {
  const emoji = p.severity === "critical" ? ":rotating_light:" : p.severity === "warning" ? ":warning:" : ":information_source:";
  const res = await fetch(cfg.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      channel: cfg.channel,
      text: `${emoji} *${p.ruleName}* — ${p.message}`,
      attachments: [
        {
          color: p.severity === "critical" ? "danger" : p.severity === "warning" ? "warning" : "good",
          fields: [
            { title: "Metric", value: p.metric, short: true },
            { title: "Value", value: String(p.value), short: true },
            { title: "Threshold", value: String(p.threshold), short: true },
            ...(p.instanceName ? [{ title: "Instance", value: p.instanceName, short: true }] : []),
          ],
          ts: Math.floor(p.firedAt / 1000),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text().catch(() => "")}`);
}

async function deliverNtfy(cfg: NtfyConfig, p: AlertPayload): Promise<void> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(cfg.topic)}`;
  const headers: Record<string, string> = {
    "content-type": "text/plain",
    title: `[${p.severity}] ${p.ruleName}`,
    tags: p.severity,
    priority: String(cfg.priority ?? (p.severity === "critical" ? 5 : p.severity === "warning" ? 4 : 3)),
  };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const res = await fetch(url, { method: "POST", headers, body: p.message });
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text().catch(() => "")}`);
}

async function deliverWebhook(cfg: WebhookConfig, p: AlertPayload): Promise<void> {
  const body = JSON.stringify(p);
  const headers: Record<string, string> = { "content-type": "application/json", ...cfg.headers };
  if (cfg.hmacSecret) {
    const { createHmac } = await import("node:crypto");
    const sig = createHmac("sha256", cfg.hmacSecret).update(body).digest("hex");
    headers["x-vmui-signature"] = `sha256=${sig}`;
  }
  const res = await fetch(cfg.url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`Webhook ${res.status}: ${await res.text().catch(() => "")}`);
}

let smtpTransport: Transporter | null = null;
let smtpKey = "";
function smtp(cfg: SmtpConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.username ?? ""}`;
  if (smtpTransport && smtpKey === key) return smtpTransport;
  smtpTransport = createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure ?? cfg.port === 465,
    auth: cfg.username && cfg.password ? { user: cfg.username, pass: cfg.password } : undefined,
  });
  smtpKey = key;
  return smtpTransport;
}

async function deliverSmtp(cfg: SmtpConfig, p: AlertPayload): Promise<void> {
  await smtp(cfg).sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: `[${p.severity.toUpperCase()}] vmui · ${p.ruleName}`,
    text: `${p.message}\n\nMetric: ${p.metric}\nValue: ${p.value}\nThreshold: ${p.threshold}\nInstance: ${p.instanceName ?? p.instanceId ?? "(none)"}\nFired at: ${new Date(p.firedAt).toISOString()}\n`,
  });
}

/**
 * Deliver to a single channel. Returns a result object instead of throwing so
 * one bad channel doesn't break the others.
 */
export async function deliverChannel(
  channelName: string,
  channel: ChannelConfig,
  payload: AlertPayload,
): Promise<DeliveryResult> {
  try {
    switch (channel.kind) {
      case "toast":
        // Server-side: nothing to do; client toasts are wired via SSE event-bus.
        return { ok: true, channelKind: "toast", channelName };
      case "discord":
        await deliverDiscord(channel.config, payload);
        break;
      case "slack":
        await deliverSlack(channel.config, payload);
        break;
      case "ntfy":
        await deliverNtfy(channel.config, payload);
        break;
      case "webhook":
        await deliverWebhook(channel.config, payload);
        break;
      case "smtp":
        await deliverSmtp(channel.config, payload);
        break;
    }
    return { ok: true, channelKind: channel.kind, channelName };
  } catch (err) {
    return {
      ok: false,
      channelKind: channel.kind,
      channelName,
      error: err instanceof Error ? err.message : "unknown",
    };
  }
}
