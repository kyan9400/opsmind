"use client";

import { IconAnalytics, IconDocuments, IconOverview, IconSparkles, IconTrendUp } from "@/components/icons";
import { LogoMark } from "@/components/Logo";
import { useT } from "@/lib/i18n/provider";

// Hand-drawn series for the hero picture: a steady trend with one obvious spike to flag.
const SERIES = [42, 44, 43, 47, 46, 49, 48, 52, 50, 53, 55, 54, 57, 56, 59, 84, 60, 61, 63, 62, 65, 67, 66, 69];
const SPIKE = 15;

function Chart() {
  const w = 520;
  const h = 150;
  const max = 90;
  const min = 30;
  const x = (i: number) => (i / (SERIES.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / (max - min)) * h;
  const line = SERIES.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${h + 4}`} className="h-auto w-full" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="mock-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--viz-series-1)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--viz-series-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={w} y1={h * f} y2={h * f} stroke="var(--viz-grid)" strokeWidth="1" />
      ))}
      <path d={`${line}L${w},${h}L0,${h}Z`} fill="url(#mock-area)" />
      <path
        d={line}
        fill="none"
        stroke="var(--viz-series-1)"
        strokeWidth="2.25"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={x(SPIKE)}
        cy={y(SERIES[SPIKE])}
        r="5"
        fill="var(--viz-critical)"
        stroke="var(--viz-surface)"
        strokeWidth="2"
      />
    </svg>
  );
}

/**
 * Decorative product picture for the landing hero, drawn with the real design tokens so it always matches
 * the current theme and language (a static screenshot would not). Hidden from assistive technology.
 */
export function ProductMockup() {
  const t = useT();
  const kpis = [
    { label: t("landing.mock.revenue"), value: "$412.8K", delta: "+12.4%" },
    { label: t("landing.mock.orders"), value: "8,931", delta: "+6.1%" },
    { label: t("landing.mock.satisfaction"), value: "93.2%", delta: "+1.8%" },
  ];
  const nav = [
    { label: t("nav.overview"), Icon: IconOverview },
    { label: t("nav.analytics"), Icon: IconAnalytics, active: true },
    { label: t("nav.documents"), Icon: IconDocuments },
    { label: t("nav.ask"), Icon: IconSparkles },
  ];

  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-2xl border border-line bg-surface shadow-overlay select-none"
    >
      {/* Window chrome */}
      <div className="flex h-9 items-center gap-1.5 border-b border-line bg-muted px-4" dir="ltr">
        <span className="h-2.5 w-2.5 rounded-full bg-[#f87171]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]" />
        <span className="mx-auto rounded-md bg-surface px-10 py-0.5 text-[10px] text-fg-subtle">
          opsmind.app/dashboard/analytics
        </span>
      </div>
      <div className="flex">
        <div className="hidden w-44 shrink-0 flex-col gap-1 border-e border-line p-3 sm:flex">
          <div className="mb-2 flex items-center gap-2 px-1">
            <LogoMark size={20} />
            <span className="text-xs font-semibold text-fg">OpsMind</span>
          </div>
          {nav.map(({ label, Icon, active }) => (
            <div
              key={label}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] font-medium ${
                active ? "bg-brand-soft text-brand-soft-fg" : "text-fg-muted"
              }`}
            >
              <Icon size={13} />
              <span className="truncate">{label}</span>
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 bg-canvas p-4">
          <div className="grid grid-cols-3 gap-2.5">
            {kpis.map((k) => (
              <div key={k.label} className="rounded-lg border border-line bg-surface p-2.5">
                <p className="truncate text-[10px] text-fg-muted">{k.label}</p>
                <p className="mt-0.5 text-sm font-semibold text-fg tabular-nums sm:text-base">{k.value}</p>
                <span
                  className="mt-1 inline-flex items-center gap-0.5 rounded-full bg-success-soft px-1.5 text-[9px] font-medium text-success"
                  dir="ltr"
                >
                  <IconTrendUp size={9} strokeWidth={2.4} />
                  {k.delta}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2.5 rounded-lg border border-line bg-surface p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium text-fg-muted">{t("landing.mock.orders")}</span>
              <span className="flex gap-1 text-[9px]" dir="ltr">
                {["7d", "30d", "90d"].map((r) => (
                  <span
                    key={r}
                    className={`rounded px-1.5 py-0.5 ${r === "30d" ? "bg-muted font-semibold text-fg" : "text-fg-subtle"}`}
                  >
                    {r}
                  </span>
                ))}
              </span>
            </div>
            <Chart />
          </div>
          <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-brand-line bg-brand-soft p-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
              <IconSparkles size={11} />
            </span>
            <p className="text-[11px] leading-snug text-fg">
              <span className="font-semibold">{t("analytics.insights")}:</span> {t("landing.mock.insight")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
