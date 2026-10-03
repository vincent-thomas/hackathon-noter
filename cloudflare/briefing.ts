import { z } from "zod";
import { generateMorningBriefing } from "./agent";
import type { Env } from "./types";

const SettingsInput = z.object({
  enabled: z.boolean(),
  timezone: z.string().trim().min(1).max(100),
}).strict();

type BriefingUser = {
  id: string;
  email: string;
  morning_briefing_timezone: string;
  morning_briefing_hour: number;
  morning_briefing_last_date: string | null;
};

export function localBriefingTime(now: Date, timezone: string): { date: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
    return { date: `${value("year")}-${value("month")}-${value("day")}`, hour: Number(value("hour")) };
  } catch {
    throw new Error("invalid timezone");
  }
}

export async function briefingSettings(env: Env, userId: string) {
  const user = await env.DB.prepare(`SELECT morning_briefing_enabled, morning_briefing_timezone,
    morning_briefing_hour, morning_briefing_last_sent_at FROM users WHERE id = ?`).bind(userId).first<{
      morning_briefing_enabled: number;
      morning_briefing_timezone: string;
      morning_briefing_hour: number;
      morning_briefing_last_sent_at: number | null;
    }>();
  if (!user) throw new Error("account not found");
  return {
    enabled: Boolean(user.morning_briefing_enabled),
    timezone: user.morning_briefing_timezone,
    hour: user.morning_briefing_hour,
    lastSentAt: user.morning_briefing_last_sent_at ? new Date(user.morning_briefing_last_sent_at).toISOString() : null,
  };
}

export async function updateBriefingSettings(env: Env, userId: string, input: unknown) {
  const settings = SettingsInput.parse(input);
  localBriefingTime(new Date(), settings.timezone);
  await env.DB.prepare("UPDATE users SET morning_briefing_enabled = ?, morning_briefing_timezone = ? WHERE id = ?")
    .bind(settings.enabled ? 1 : 0, settings.timezone, userId).run();
  return briefingSettings(env, userId);
}

export async function runMorningBriefings(env: Env, now = new Date()): Promise<{ sent: number; skipped: number; failed: number }> {
  const users = (await env.DB.prepare(`SELECT id, email, morning_briefing_timezone, morning_briefing_hour,
    morning_briefing_last_date FROM users WHERE morning_briefing_enabled = 1 AND email IS NOT NULL`).all<BriefingUser>()).results;
  let sent = 0, skipped = 0, failed = 0;
  for (const user of users) {
    let local;
    try { local = localBriefingTime(now, user.morning_briefing_timezone); }
    catch { failed++; continue; }
    if (local.hour !== user.morning_briefing_hour || local.date === user.morning_briefing_last_date) { skipped++; continue; }
    const claim = await env.DB.prepare(`UPDATE users SET morning_briefing_last_date = ?, morning_briefing_last_error = NULL
      WHERE id = ? AND (morning_briefing_last_date IS NULL OR morning_briefing_last_date != ?)`)
      .bind(local.date, user.id, local.date).run();
    if (!claim.meta.changes) { skipped++; continue; }
    try {
      const briefing = await generateMorningBriefing(env, user.id, local.date, user.morning_briefing_timezone);
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
          "idempotency-key": `morning-${user.id}-${local.date}`,
        },
        body: JSON.stringify({
          from: env.RESEND_FROM || "notd <onboarding@resend.dev>",
          to: [user.email],
          subject: `Your morning briefing — ${local.date}`,
          text: briefing.content,
          html: briefingHtml(briefing.content, local.date),
          tags: [{ name: "kind", value: "morning_briefing" }],
        }),
      });
      if (!response.ok) throw new Error(`Resend ${response.status}: ${await response.text()}`);
      await env.DB.prepare("UPDATE users SET morning_briefing_last_sent_at = ?, morning_briefing_last_error = NULL WHERE id = ?")
        .bind(Date.now(), user.id).run();
      sent++;
    } catch (error) {
      await env.DB.prepare(`UPDATE users SET morning_briefing_last_date = NULL, morning_briefing_last_error = ?
        WHERE id = ? AND morning_briefing_last_date = ?`).bind(error instanceof Error ? error.message.slice(0, 1000) : String(error), user.id, local.date).run();
      console.error(`morning briefing failed for ${user.id}:`, error);
      failed++;
    }
  }
  return { sent, skipped, failed };
}

function briefingHtml(content: string, date: string) {
  const escaped = content.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<div style="max-width:600px;margin:auto;padding:32px 20px;background:#0b0b0a;color:#f7f7f3;font:16px/1.6 system-ui,sans-serif"><p style="color:#b7df39;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">notd · ${date}</p><div style="white-space:pre-wrap">${escaped}</div></div>`;
}
