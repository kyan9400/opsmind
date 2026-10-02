"use client";

import Link from "next/link";
import { demoEnabled, DemoLoginButton } from "@/components/DemoLoginButton";
import {
  IconAnalytics,
  IconGitHub,
  IconGlobe,
  IconLayers,
  IconQuote,
  IconShield,
  IconSparkles,
  IconUpload,
} from "@/components/icons";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Logo } from "@/components/Logo";
import { ProductMockup } from "@/components/ProductMockup";
import { useT } from "@/lib/i18n/provider";
import { PREVIEW, REPO_URL } from "@/lib/preview";

const features = [
  { title: "landing.feature1.title", body: "landing.feature1.body", Icon: IconQuote },
  // "Live KPI dashboards" is true of the product, not of the recorded preview.
  {
    title: PREVIEW ? "preview.feature2Title" : "landing.feature2.title",
    body: "landing.feature2.body",
    Icon: IconAnalytics,
  },
  { title: "landing.feature3.title", body: "landing.feature3.body", Icon: IconShield },
  { title: "landing.feature4.title", body: "landing.feature4.body", Icon: IconGlobe },
] as const;

const steps = [
  { title: "landing.step1.title", body: "landing.step1.body", Icon: IconUpload },
  { title: "landing.step2.title", body: "landing.step2.body", Icon: IconLayers },
  { title: "landing.step3.title", body: "landing.step3.body", Icon: IconSparkles },
] as const;

// Product names, so never translated.
const TECH = [
  "Next.js 15",
  "React 19",
  "TypeScript",
  "Tailwind CSS",
  "Express 5",
  "FastAPI",
  "PostgreSQL + pgvector",
  "Redis · BullMQ",
  "Docker",
  "Kubernetes",
  "Terraform",
  "GitHub Actions",
  "Playwright",
];

export default function Home() {
  const t = useT();
  const signIn = (
    <Link href="/login" data-testid="landing-signin" className="btn btn-secondary btn-lg">
      {t("landing.signIn")}
    </Link>
  );
  // The static preview has nothing to create a workspace in.
  const register = !PREVIEW && (
    <Link
      href="/login?mode=register"
      data-testid="landing-register"
      className={demoEnabled ? "text-sm font-medium text-brand-text hover:underline" : "btn btn-primary btn-lg"}
    >
      {t("landing.createWorkspace")}
    </Link>
  );

  return (
    <div className="min-h-screen overflow-x-clip">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-canvas/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
          <Link href="/" className="rounded-control">
            <Logo />
          </Link>
          <nav className="hidden items-center gap-1 text-sm md:flex">
            <a href="#features" className="btn btn-ghost btn-sm">
              {t("landing.navFeatures")}
            </a>
            <a href="#how" className="btn btn-ghost btn-sm">
              {t("landing.navHowItWorks")}
            </a>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
              <IconGitHub size={15} />
              GitHub
            </a>
          </nav>
          <div className="ms-auto flex items-center gap-2">
            <LanguageSwitcher />
            <Link href="/login" className="btn btn-ghost btn-sm hidden sm:inline-flex">
              {t("landing.signIn")}
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative">
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute inset-x-0 top-0 h-[36rem] bg-[radial-gradient(50%_60%_at_50%_0%,var(--brand-soft),transparent)]" />
            <div className="absolute inset-x-0 top-0 h-[36rem] [background-image:linear-gradient(var(--line)_1px,transparent_1px),linear-gradient(90deg,var(--line)_1px,transparent_1px)] [background-size:48px_48px] opacity-50 [mask-image:radial-gradient(60%_50%_at_50%_0%,black,transparent)]" />
          </div>
          <div className="mx-auto max-w-6xl px-4 pt-16 pb-12 text-center sm:px-6 sm:pt-24">
            <p className="inline-flex items-center gap-2 rounded-full border border-brand-line bg-surface/80 px-3 py-1 text-xs font-medium text-brand-soft-fg shadow-xs">
              <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
              {t("landing.eyebrow")}
            </p>
            <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold tracking-tight text-balance text-fg sm:text-5xl lg:text-display">
              {t("landing.tagline")}
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-pretty text-fg-muted sm:text-lg">
              {t("landing.subline")}
            </p>
            <div className="mt-8 flex flex-wrap items-start justify-center gap-3">
              {demoEnabled ? (
                <>
                  <DemoLoginButton size="lg" />
                  {signIn}
                </>
              ) : (
                <>
                  {register}
                  {signIn}
                </>
              )}
            </div>
            {demoEnabled && register && <p className="mt-4">{register}</p>}
          </div>

          <div className="mx-auto max-w-5xl px-4 pb-20 sm:px-6">
            <div className="relative">
              <div
                aria-hidden
                className="absolute -inset-x-8 -inset-y-6 -z-10 rounded-[2rem] bg-gradient-to-b from-indigo-500/15 via-violet-500/10 to-transparent blur-2xl"
              />
              <ProductMockup />
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-16 border-t border-line bg-surface py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-semibold tracking-tight text-balance text-fg">
                {t("landing.featuresTitle")}
              </h2>
              <p className="mt-3 text-fg-muted">{t("landing.featuresSubtitle")}</p>
            </div>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {features.map(({ title, body, Icon }) => (
                <div key={title} className="rounded-card border border-line bg-canvas p-6">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand-text">
                    <Icon size={20} />
                  </span>
                  <h3 className="mt-4 font-semibold text-fg">{t(title)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t(body)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works + tech */}
        <section id="how" className="scroll-mt-16 border-t border-line py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-center text-3xl font-semibold tracking-tight text-fg">{t("landing.howTitle")}</h2>
            <ol className="mt-12 grid gap-6 md:grid-cols-3">
              {steps.map(({ title, body, Icon }, i) => (
                <li key={title} className="card relative p-6">
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-semibold text-brand-fg tabular-nums">
                      {i + 1}
                    </span>
                    <Icon size={18} className="text-fg-subtle" />
                  </div>
                  <h3 className="mt-4 font-semibold text-fg">{t(title)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t(body)}</p>
                </li>
              ))}
            </ol>

            <div className="mt-16 text-center">
              <p className="eyebrow">{t("landing.techTitle")}</p>
              <ul className="mx-auto mt-4 flex max-w-3xl flex-wrap justify-center gap-2" dir="ltr">
                {TECH.map((name) => (
                  <li
                    key={name}
                    className="rounded-full border border-line bg-surface px-3 py-1 text-xs font-medium text-fg-muted shadow-xs"
                  >
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm sm:flex-row sm:px-6">
          <div className="flex flex-col items-center gap-2 sm:flex-row sm:gap-4">
            <Logo size={24} />
            <span className="text-fg-subtle">{t("landing.footerNote")}</span>
          </div>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
            data-testid="landing-github"
          >
            <IconGitHub size={15} />
            {t("landing.viewSource")}
          </a>
        </div>
      </footer>
    </div>
  );
}
