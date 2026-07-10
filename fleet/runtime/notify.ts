// The notify/email seam. A TS agent DELIVERS a message — a digest to the operator,
// a budget-exhaustion alert — through this interface, the orchestration-layer twin
// of the Go core/tool/email governed tool (the same way ctx.writeRepoFile is the
// orchestration twin of the Go fs `write` tool). Delivery is DRY-RUN by default:
// the message is RECORDED and NOTHING is sent, so a $0/offline run exercises the
// seam with no credential, no network, and no live mail. Credentialed live delivery
// (an SMTP/Gmail adapter) fails CLOSED and is a deployment config — the interface
// here is the seam it plugs into.
//
//   - DryRunNotifier — records every message and delivers nothing (the $0 default,
//     used both as the production default and as the test double a test reads back).
//
// A live CliNotifier (shelling `agix-core` to invoke the Go email tool with its
// guard-bee grant + a wired SMTP/Gmail transport) satisfies this same interface and
// is the tracked follow-up — see the port notes.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

/** One email to deliver. `to`/`cc` accept a single address or a list; `body` is
 *  required. A logical recipient like "operator" is resolved by the transport. */
export interface EmailMessage {
  to: string | string[];
  cc?: string | string[];
  from?: string;
  subject?: string;
  body: string;
}

/** One generic notification. `channel` names the delivery surface ("email", a chat
 *  channel, an alert bus); `level` is the severity; `body` is required. */
export interface NotifyMessage {
  channel?: string;
  title?: string;
  body: string;
  to?: string | string[];
  level?: "info" | "warn" | "critical";
}

/** The outcome of one delivery attempt. A dry-run/degraded delivery is `queued`
 *  (recorded, not sent); a live delivery is `sent`. `mode` names the path taken. */
export interface DeliveryResult {
  sent: boolean;
  queued: boolean;
  mode: string; // "dry-run" | "queued" | a live transport mode
  channel: string;
  id?: string;
  detail?: string;
}

/** The delivery seam an AgentContext exposes as ctx.sendEmail / ctx.notify. */
export interface Notifier {
  sendEmail(msg: EmailMessage): Promise<DeliveryResult>;
  notify(msg: NotifyMessage): Promise<DeliveryResult>;
}

function toList(v: string | string[] | undefined): string[] {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
}

/** DryRunNotifier is the $0/offline default: it RECORDS every message and delivers
 *  NOTHING. It is the production default (a run with no live transport degrades
 *  honestly to a recorded queue) AND the test double — a test injects one and reads
 *  `.emails` / `.notifications` to assert what WOULD have been sent. It never holds
 *  a credential and never touches the network. */
export class DryRunNotifier implements Notifier {
  readonly emails: EmailMessage[] = [];
  readonly notifications: NotifyMessage[] = [];

  /** Optional line sink (defaults to a stderr breadcrumb so stdout stays clean for
   *  --json). Pass a no-op to silence it in tests. */
  constructor(private readonly sink: (line: string) => void = (l) => process.stderr.write(l + "\n")) {}

  async sendEmail(msg: EmailMessage): Promise<DeliveryResult> {
    this.emails.push(msg);
    const to = toList(msg.to).join(", ") || "(no recipient)";
    this.sink(`[notify:dry-run] email → ${to} · ${msg.subject ?? "(no subject)"}`);
    return { sent: false, queued: true, mode: "dry-run", channel: "email", detail: "recorded, not sent ($0 offline default)" };
  }

  async notify(msg: NotifyMessage): Promise<DeliveryResult> {
    this.notifications.push(msg);
    const channel = (msg.channel ?? "log").trim() || "log";
    const label = msg.title ?? msg.body.slice(0, 60);
    this.sink(`[notify:dry-run] ${channel}${msg.level ? "/" + msg.level : ""} · ${label}`);
    return { sent: false, queued: true, mode: "dry-run", channel, detail: "recorded, not sent" };
  }
}
