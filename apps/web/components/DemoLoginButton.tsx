"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, setToken } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

// Inlined at build time; when either is unset the button is not rendered at all.
const DEMO_EMAIL = process.env.NEXT_PUBLIC_DEMO_EMAIL;
const DEMO_PASSWORD = process.env.NEXT_PUBLIC_DEMO_PASSWORD;

export const demoEnabled = Boolean(DEMO_EMAIL && DEMO_PASSWORD);

/** One-click sign-in to a shared read-only demo workspace, landing straight on the analytics view. */
export function DemoLoginButton({ className = "" }: { className?: string }) {
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
        className="rounded-lg border border-indigo-300 px-4 py-2 text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950"
      >
        {busy ? t("demo.loading") : t("demo.button")}
      </button>
      {error && (
        <p role="alert" data-testid="demo-login-error" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
