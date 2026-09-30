"use client";

import Link from "next/link";
import { DemoLoginButton } from "@/components/DemoLoginButton";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { useT } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

const features = [
  { title: "landing.feature1.title", body: "landing.feature1.body" },
  // "Live KPI dashboards" is true of the product, not of the recorded preview.
  { title: PREVIEW ? "preview.feature2Title" : "landing.feature2.title", body: "landing.feature2.body" },
  { title: "landing.feature3.title", body: "landing.feature3.body" },
] as const;

export default function Home() {
  const t = useT();
  return (
    <main className="relative mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16">
      <LanguageSwitcher className="absolute end-6 top-6" />
      <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">OpsMind</p>
      <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">{t("landing.tagline")}</h1>
      <div className="mt-8 flex flex-wrap items-start gap-3">
        {/* The static preview has nothing to create a workspace in. */}
        {!PREVIEW && (
          <Link
            href="/login?mode=register"
            data-testid="landing-register"
            className="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500"
          >
            {t("landing.createWorkspace")}
          </Link>
        )}
        <Link
          href="/login"
          data-testid="landing-signin"
          className="rounded-lg border border-zinc-300 px-4 py-2 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {t("landing.signIn")}
        </Link>
        <DemoLoginButton />
      </div>
      <div className="mt-16 grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="font-medium">{t(f.title)}</h2>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{t(f.body)}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
