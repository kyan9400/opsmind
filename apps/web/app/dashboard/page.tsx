"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import {
  IconActivity,
  IconAnalytics,
  IconArrowRight,
  IconDocuments,
  IconSparkles,
  IconUserPlus,
  IconUsers,
} from "@/components/icons";
import { Page, PageHeader } from "@/components/PageHeader";
import { api, ApiError, atLeast, RANK, type AuditEvent, type Me, type User } from "@/lib/api";
import { intlLocale } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";

const shortcuts = [
  { href: "/dashboard/analytics", title: "analytics.title", body: "landing.feature2.body", Icon: IconAnalytics },
  { href: "/dashboard/documents", title: "docs.title", body: "docs.subtitle", Icon: IconDocuments },
  { href: "/dashboard/ask", title: "ask.title", body: "ask.subtitle", Icon: IconSparkles },
] as const;

const ROLE_BADGE: Record<string, string> = {
  owner: "badge-brand",
  admin: "badge-brand",
  member: "badge-neutral",
  viewer: "badge-neutral",
};

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

  if (!me)
    return (
      <Page>
        <p className="text-sm text-fg-muted" role={error ? "alert" : "status"}>
          {error ?? t("common.loading")}
        </p>
      </Page>
    );

  const isAdmin = atLeast(me.role, "admin");

  return (
    <Page>
      <PageHeader
        title={t("overview.welcome", { name: me.name })}
        titleTestId="overview-welcome"
        description={
          <>
            <span className="font-medium text-fg">{me.tenantName}</span> · {t("overview.subtitle")}
          </>
        }
      />

      {error && (
        <p role="alert" className="mt-4 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-text">
          {error}
        </p>
      )}

      <section className="mt-6" aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title" className="eyebrow">
          {t("overview.shortcuts")}
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {shortcuts.map(({ href, title, body, Icon }) => (
            <Link
              key={href}
              href={href}
              className="card group flex flex-col p-4 transition-colors hover:border-brand-line hover:shadow-raised"
            >
              <span className="flex items-center justify-between">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-soft text-brand-text">
                  <Icon size={18} />
                </span>
                <IconArrowRight
                  size={16}
                  className="text-fg-subtle transition-transform ltr:group-hover:translate-x-0.5 group-hover:text-brand-text rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                />
              </span>
              <span className="mt-3 text-sm font-semibold text-fg">{t(title)}</span>
              <span className="mt-1 line-clamp-2 text-sm text-fg-muted">{t(body)}</span>
            </Link>
          ))}
        </div>
      </section>

      <div className={`mt-6 grid gap-6 ${isAdmin ? "lg:grid-cols-5" : ""}`}>
        <section className={`card ${isAdmin ? "lg:col-span-3" : ""}`}>
          <h2 className="flex items-center gap-2 border-b border-line px-5 py-3.5 text-sm font-semibold text-fg">
            <IconUsers size={16} className="text-fg-subtle" />
            {t("overview.team", { count: users.length })}
          </h2>
          <ul className="divide-y divide-line" data-testid="team-list">
            {users.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                <Avatar name={u.name} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-fg">{u.name}</span>
                  <span className="block truncate text-xs text-fg-subtle">{u.email}</span>
                </span>
                <span className={`badge ${ROLE_BADGE[u.role]}`} data-role={u.role}>
                  {t(`role.${u.role}`)}
                </span>
              </li>
            ))}
          </ul>
          {isAdmin && (
            <form
              onSubmit={addUser}
              className="border-t border-line bg-muted/50 px-5 py-4"
              data-testid="add-member-form"
            >
              <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
                <IconUserPlus size={16} className="text-fg-subtle" />
                {t("overview.inviteTitle")}
              </h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <input
                  name="name"
                  placeholder={t("overview.name")}
                  aria-label={t("overview.name")}
                  required
                  className="input"
                />
                <input
                  name="email"
                  type="email"
                  placeholder={t("overview.email")}
                  aria-label={t("overview.email")}
                  required
                  className="input"
                />
                <input
                  name="password"
                  type="password"
                  placeholder={t("overview.tempPassword")}
                  aria-label={t("overview.tempPassword")}
                  minLength={8}
                  required
                  className="input"
                />
                <div className="flex gap-2">
                  <select
                    name="role"
                    defaultValue="member"
                    aria-label={t("overview.role")}
                    className="input min-w-0 flex-1"
                  >
                    {RANK.filter((r) => RANK.indexOf(r) < RANK.indexOf(me.role)).map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}`)}
                      </option>
                    ))}
                  </select>
                  <button className="btn btn-primary h-10" data-testid="add-member-submit">
                    {t("overview.addMember")}
                  </button>
                </div>
              </div>
            </form>
          )}
        </section>

        {isAdmin && (
          <section className="card lg:col-span-2">
            <h2 className="flex items-center gap-2 border-b border-line px-5 py-3.5 text-sm font-semibold text-fg">
              <IconActivity size={16} className="text-fg-subtle" />
              {t("overview.recentActivity")}
            </h2>
            {events.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-fg-muted">{t("overview.noActivity")}</p>
            ) : (
              <ol className="px-5 py-4">
                {events.map((e, i) => (
                  <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {/* Timeline rail */}
                    {i < events.length - 1 && (
                      <span aria-hidden className="absolute start-[5px] top-4 bottom-0 w-px bg-line" />
                    )}
                    <span
                      aria-hidden
                      className="mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-brand bg-surface"
                    />
                    <div className="min-w-0 text-sm">
                      <p className="text-fg">
                        <code className="rounded bg-brand-soft px-1 py-0.5 font-mono text-xs text-brand-soft-fg">
                          {e.action}
                        </code>{" "}
                        <span className="break-all">{e.target}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {t("overview.by", { actor: e.actorEmail ?? t("overview.system") })} ·{" "}
                        <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString(intlLocale(locale))}</time>
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </Page>
  );
}
