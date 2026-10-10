"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import {
  IconAnalytics,
  IconClose,
  IconDocuments,
  IconLogOut,
  IconMenu,
  IconOverview,
  IconSparkles,
} from "@/components/icons";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Logo } from "@/components/Logo";
import { SandboxBanner } from "@/components/SandboxBanner";
import { api, clearToken, type Me } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

const links = [
  { href: "/dashboard", label: "nav.overview", testId: "nav-overview", Icon: IconOverview },
  { href: "/dashboard/analytics", label: "nav.analytics", testId: "nav-analytics", Icon: IconAnalytics },
  { href: "/dashboard/documents", label: "nav.documents", testId: "nav-documents", Icon: IconDocuments },
  { href: "/dashboard/ask", label: "nav.ask", testId: "nav-ask", Icon: IconSparkles },
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  // The static preview is exported with trailingSlash, so the browser reports "/dashboard/analytics/".
  const pathname = usePathname().replace(/(.)\/+$/, "$1");
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const current = links.find((l) => l.href === pathname);

  // Only for the workspace/user block; each page still does its own auth check and 401 redirect.
  useEffect(() => {
    api<Me>("/auth/me").then(setMe, () => {});
  }, []);

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    // The page behind an open drawer is inert, so the drawer must not stay open once the window is wide
    // enough to show the sidebar as a column.
    const wide = window.matchMedia("(min-width: 64rem)");
    const onWide = () => wide.matches && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    wide.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      wide.removeEventListener("change", onWide);
    };
  }, [menuOpen]);

  // Opening moves focus into the drawer; closing brings it back to the menu button, unless the user has
  // already put it somewhere else outside the drawer.
  useEffect(() => {
    if (menuOpen) {
      sidebarRef.current?.querySelector<HTMLElement>("nav a")?.focus();
    } else if (wasOpen.current) {
      const active = document.activeElement;
      if (!active || active === document.body || sidebarRef.current?.contains(active)) menuButtonRef.current?.focus();
    }
    wasOpen.current = menuOpen;
  }, [menuOpen]);

  return (
    <div className="flex min-h-screen">
      {menuOpen && (
        <button
          type="button"
          aria-label={t("nav.closeMenu")}
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-40 bg-slate-950/40 backdrop-blur-[2px] lg:hidden"
        />
      )}

      {/* One sidebar for every width: a sticky column from lg up, an off-canvas drawer below (start edge, so
          it slides in from the right in Arabic). A closed drawer is `invisible`, which keeps it out of the tab order. */}
      <aside
        ref={sidebarRef}
        id="app-sidebar"
        className={`z-50 w-64 shrink-0 border-e border-line bg-surface transition-[translate,visibility] duration-200 max-lg:fixed max-lg:inset-y-0 max-lg:start-0 max-lg:shadow-overlay ${
          menuOpen
            ? "max-lg:visible max-lg:translate-x-0"
            : "max-lg:invisible max-lg:ltr:-translate-x-full max-lg:rtl:translate-x-full"
        }`}
      >
        {/* The column spans the page; only its contents stick, so the border and surface never end mid-page. */}
        <div className="flex h-full flex-col lg:sticky lg:top-0 lg:h-dvh">
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
            <Link href="/dashboard" className="rounded-control">
              <Logo />
            </Link>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              aria-label={t("nav.closeMenu")}
              className="btn btn-ghost btn-sm w-8 px-0 lg:hidden"
            >
              <IconClose />
            </button>
          </div>

          <nav aria-label={t("nav.label")} className="flex-1 overflow-y-auto px-3 py-3">
            <ul className="space-y-0.5">
              {links.map(({ href, label, testId, Icon }) => {
                const active = pathname === href;
                return (
                  <li key={href}>
                    <Link
                      href={href}
                      data-testid={testId}
                      aria-current={active ? "page" : undefined}
                      className={`flex h-9 items-center gap-3 rounded-control px-3 text-sm font-medium transition-colors ${
                        active ? "bg-brand-soft text-brand-soft-fg" : "text-fg-muted hover:bg-muted hover:text-fg"
                      }`}
                    >
                      <Icon size={18} className={active ? "text-brand-text" : "text-fg-subtle"} />
                      {t(label)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="shrink-0 border-t border-line p-3">
            {me && (
              <div className="mb-2 rounded-control bg-muted p-3" data-testid="sidebar-account">
                <p className="eyebrow">{t("nav.workspace")}</p>
                <p className="mt-0.5 truncate text-sm font-semibold text-fg">{me.tenantName}</p>
                <div className="mt-3 flex items-center gap-2.5">
                  <Avatar name={me.name} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">{me.name}</p>
                    <p className="truncate text-xs text-fg-subtle">{t(`role.${me.role}`)}</p>
                  </div>
                </div>
              </div>
            )}
            <button
              onClick={() => {
                clearToken();
                router.push("/login");
              }}
              data-testid="nav-signout"
              className="btn btn-ghost w-full justify-start gap-3 px-3"
            >
              <IconLogOut size={18} className="text-fg-subtle rtl:-scale-x-100" />
              {t("nav.signOut")}
            </button>
          </div>
        </div>
      </aside>

      {/* While the drawer is open, the page under the overlay is out of reach for Tab and screen readers. */}
      <div className="flex min-w-0 flex-1 flex-col" inert={menuOpen}>
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label={t("nav.openMenu")}
            aria-expanded={menuOpen}
            aria-controls="app-sidebar"
            className="btn btn-ghost btn-sm -ms-1.5 w-8 px-0 lg:hidden"
          >
            <IconMenu size={20} />
          </button>
          <div className="flex min-w-0 items-center gap-2 text-sm">
            {me && (
              <>
                <span className="hidden truncate text-fg-subtle sm:inline">{me.tenantName}</span>
                <span aria-hidden className="hidden text-line-strong sm:inline">
                  /
                </span>
              </>
            )}
            <span className="truncate font-semibold text-fg">{current ? t(current.label) : "OpsMind"}</span>
          </div>
          <LanguageSwitcher className="ms-auto" />
        </header>
        {me?.expiresAt && <SandboxBanner expiresAt={me.expiresAt} />}
        {children}
      </div>
    </div>
  );
}
