"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, atLeast, RANK, type AuditEvent, type Me, type User } from "@/lib/api";
import { intlLocale } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";

export default function Dashboard() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await api<Me>("/auth/me");
      setMe(m);
      setUsers((await api<{ data: User[] }>("/users")).data);
      if (atLeast(m.role, "admin")) setEvents((await api<{ data: AuditEvent[] }>("/audit?limit=10")).data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return router.replace("/login");
      setError((err as Error).message);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  async function addUser(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api("/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!me) return <main className="p-8 text-zinc-500">{error ?? t("common.loading")}</main>;

  const field = "rounded border px-2 py-1 text-sm dark:border-zinc-700 dark:bg-transparent";

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <p className="text-sm text-zinc-500">{me.tenantName}</p>
        <h1 className="text-2xl font-semibold" data-testid="overview-welcome">
          {t("overview.welcome", { name: me.name })}
        </h1>
      </header>

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <section className="mt-8 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="font-medium">{t("overview.team", { count: users.length })}</h2>
        <ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="team-list">
          {users.map((u) => (
            <li key={u.id} className="flex justify-between py-2 text-sm">
              <span>
                {u.name} <span className="text-zinc-500">· {u.email}</span>
              </span>
              <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800" data-role={u.role}>
                {t(`role.${u.role}`)}
              </span>
            </li>
          ))}
        </ul>
        {atLeast(me.role, "admin") && (
          <form onSubmit={addUser} className="mt-4 grid gap-2 sm:grid-cols-5" data-testid="add-member-form">
            <input name="name" placeholder={t("overview.name")} aria-label={t("overview.name")} required className={field} />
            <input
              name="email"
              type="email"
              placeholder={t("overview.email")}
              aria-label={t("overview.email")}
              required
              className={field}
            />
            <input
              name="password"
              type="password"
              placeholder={t("overview.tempPassword")}
              aria-label={t("overview.tempPassword")}
              minLength={8}
              required
              className={field}
            />
            <select
              name="role"
              defaultValue="member"
              aria-label={t("overview.role")}
              className="rounded border px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              {RANK.filter((r) => RANK.indexOf(r) < RANK.indexOf(me.role)).map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
            <button className="rounded bg-indigo-600 px-3 py-1 text-sm text-white" data-testid="add-member-submit">
              {t("overview.addMember")}
            </button>
          </form>
        )}
      </section>

      {atLeast(me.role, "admin") && (
        <section className="mt-6 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
          <h2 className="font-medium">{t("overview.recentActivity")}</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between gap-4">
                <span>
                  <code className="text-indigo-600 dark:text-indigo-400">{e.action}</code> {e.target}
                  <span className="text-zinc-500"> {t("overview.by", { actor: e.actorEmail ?? t("overview.system") })}</span>
                </span>
                <time className="shrink-0 text-zinc-500" dateTime={e.createdAt}>
                  {new Date(e.createdAt).toLocaleString(intlLocale(locale))}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
