// Notify/email seam tests — HERMETIC ($0/offline, no Go binary, no key, no network).
// Exercise ctx.sendEmail / ctx.notify against a DryRunNotifier and assert:
//   - a declared email/notify capability ROUTES the call to the notifier, which
//     RECORDS the message and returns queued/not-sent (the $0 dry-run default);
//   - the capability aliases (email|notify|mail|send|alert) all authorize the seam;
//   - it FAILS CLOSED: an agent that does not declare the capability cannot send.
//
// Copyright 2026 Agix AI LLC. Apache-2.0.

import { test, expect, describe } from "bun:test";
import { buildContext } from "../runtime/context.ts";
import { MockEngine } from "../runtime/engine.ts";
import { MemComb } from "../runtime/comb.ts";
import { DryRunNotifier } from "../runtime/notify.ts";
import type { Manifest } from "../runtime/manifest.ts";

function ctxFor(tools: string[], notifier: DryRunNotifier) {
  const manifest: Manifest = {
    name: "probe",
    public: true,
    role: "proposer",
    trust: "proposer",
    instructions: "exercise the notify seam",
    tools,
  };
  return buildContext({
    manifest,
    input: { args: [], text: "", flags: {} },
    engine: new MockEngine(),
    comb: new MemComb(),
    notifier,
    dir: "agents",
    provider: "mock",
    publicOnly: false,
    smoke: false,
    repoRoot: "/tmp",
  });
}

describe("notify seam (ctx.sendEmail / ctx.notify)", () => {
  test("a declared email capability routes sendEmail to the notifier (dry-run: recorded, not sent)", async () => {
    const notifier = new DryRunNotifier(() => {});
    const ctx = ctxFor(["email"], notifier);

    const r = await ctx.sendEmail({ to: "operator", subject: "Digest", body: "3 threads need you" });
    expect(r.sent).toBe(false);
    expect(r.queued).toBe(true);
    expect(r.mode).toBe("dry-run");
    expect(r.channel).toBe("email");

    // The message was recorded exactly once, verbatim.
    expect(notifier.emails.length).toBe(1);
    expect(notifier.emails[0].to).toBe("operator");
    expect(notifier.emails[0].body).toBe("3 threads need you");
  });

  test("a declared notify capability routes notify() and records the notification", async () => {
    const notifier = new DryRunNotifier(() => {});
    const ctx = ctxFor(["notify"], notifier);

    const r = await ctx.notify({ channel: "ci-alert", level: "critical", title: "exhausted", body: "raise the limit" });
    expect(r.queued).toBe(true);
    expect(r.channel).toBe("ci-alert");
    expect(notifier.notifications.length).toBe(1);
    expect(notifier.notifications[0].level).toBe("critical");
    expect(notifier.notifications[0].title).toBe("exhausted");
  });

  test("every capability alias authorizes the seam", async () => {
    for (const alias of ["email", "notify", "mail", "send", "alert"]) {
      const notifier = new DryRunNotifier(() => {});
      const ctx = ctxFor([alias], notifier);
      const r = await ctx.sendEmail({ to: "operator", body: "x" });
      expect(r.queued).toBe(true);
    }
  });

  test("FAILS CLOSED: an agent that does not declare email/notify cannot send", async () => {
    const notifier = new DryRunNotifier(() => {});
    const ctx = ctxFor(["read", "write"], notifier);

    await expect(ctx.sendEmail({ to: "operator", body: "x" })).rejects.toThrow(/does not declare an email\/notify/);
    await expect(ctx.notify({ body: "x" })).rejects.toThrow(/does not declare an email\/notify/);
    // Nothing was recorded — the seam never reached the transport.
    expect(notifier.emails.length).toBe(0);
    expect(notifier.notifications.length).toBe(0);
  });
});
