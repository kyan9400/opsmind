"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconSparkles } from "@/components/icons";
import { api, setToken } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

// Inlined at build time; when either is unset the button is not rendered at all.
const DEMO_EMAIL = process.env.NEXT_PUBLIC_DEMO_EMAIL;
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD;

export const demoEnabled = Boolean(DEMO_EMAIL && DEMO_PASSWORD);

/** One-click sign-in to a shared read-only demo workspace, landing straight on the analytics view. */
export function DemoLoginButton({
  className = "",
  variant = "primary",
  size = "md",
}: {
  className?: string;
  variant?: "primary" | "soft";
  size?: "md" | "lg";
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!demoEnabled) return null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { token } = await api<{ token: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      });
      setToken(token);
      router.push("/dashboard/analytics");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        data-testid="demo-login"
        // In the static preview it is the only way in, so it is always the main button (and never says "live").
        className={`btn ${size === "lg" ? "btn-lg" : ""} ${PREVIEW || variant === "primary" ? "btn-primary" : "btn-soft"} group`}
      >
        <IconSparkles size={size === "lg" ? 18 : 16} />
        {busy ? t("demo.loading") : PREVIEW ? t("preview.demoButton") : t("demo.button")}
        <IconArrowRight
          size={16}
          className="opacity-70 transition-transform ltr:group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
        />
      </button>
      {error && (
        <p role="alert" data-testid="demo-login-error" className="mt-2 text-sm text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
