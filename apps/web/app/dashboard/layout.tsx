"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { clearToken } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

const links = [
  { href: "/dashboard", label: "nav.overview", testId: "nav-overview" },
  { href: "/dashboard/analytics", label: "nav.analytics", testId: "nav-analytics" },
  { href: "/dashboard/documents", label: "nav.documents", testId: "nav-documents" },
  { href: "/dashboard/ask", label: "nav.ask", testId: "nav-ask" },
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const t = useT();
  // The static preview is exported with trailingSlash, so the browser reports "/dashboard/analytics/".
  const pathname = usePathname().replace(/(.)\/+$/, "$1");
  const router = useRouter();

  return (
    <div className="min-h-screen">
      <nav aria-label={t("nav.label")} className="border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
          <span className="font-semibold">OpsMind</span>
          <div className="flex flex-wrap gap-1 text-sm">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                data-testid={l.testId}
                aria-current={pathname === l.href ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 ${
                  pathname === l.href
                    ? "bg-zinc-200 font-medium dark:bg-zinc-800"
                    : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                }`}
              >
                {t(l.label)}
              </Link>
            ))}
          </div>
          <div className="ms-auto flex items-center gap-3">
            <LanguageSwitcher />
            <button
              onClick={() => {
                clearToken();
                router.push("/login");
              }}
              data-testid="nav-signout"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
            >
              {t("nav.signOut")}
            </button>
          </div>
        </div>
      </nav>
      {children}
    </div>
  );
}
