"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DemoLoginButton } from "@/components/DemoLoginButton";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { api, setToken } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

/** The static preview has one account, the read-only demo viewer: offer exactly that. */
function PreviewSignIn() {
  const t = useT();
  return (
    <main className="relative mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <LanguageSwitcher className="absolute end-6 top-6" />
      <h1 className="text-2xl font-semibold">{t("login.titleSignIn")}</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{t("preview.loginHint")}</p>
      <DemoLoginButton className="mt-6 [&>button]:w-full" />
    </main>
  );
}

function AuthForm() {
  const t = useT();
  const router = useRouter();
  const [mode, setMode] = useState(useSearchParams().get("mode") === "register" ? "register" : "login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const { token } = await api<{ token: string }>(`/auth/${mode}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setToken(token);
      router.push("/dashboard");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 outline-none focus:border-indigo-500 dark:border-zinc-700";

  return (
    <main className="relative mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <LanguageSwitcher className="absolute end-6 top-6" />
      <h1 className="text-2xl font-semibold">{mode === "login" ? t("login.titleSignIn") : t("login.titleRegister")}</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-3" data-testid="login-form">
        {mode === "register" && (
          <>
            <input
              name="tenantName"
              placeholder={t("login.companyName")}
              aria-label={t("login.companyName")}
              required
              data-testid="login-tenant"
              className={input}
            />
            <input
              name="name"
              placeholder={t("login.yourName")}
              aria-label={t("login.yourName")}
              required
              data-testid="login-name"
              className={input}
            />
          </>
        )}
        <input
          name="email"
          type="email"
          placeholder={t("login.email")}
          aria-label={t("login.email")}
          autoComplete="email"
          required
          data-testid="login-email"
          className={input}
        />
        <input
          name="password"
          type="password"
          placeholder={t("login.password")}
          aria-label={t("login.password")}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "register" ? 8 : undefined}
          required
          data-testid="login-password"
          className={input}
        />
        {error && (
          <p role="alert" data-testid="login-error" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <button
          disabled={busy}
          data-testid="login-submit"
          className="w-full rounded-lg bg-indigo-600 py-2 text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {busy ? "…" : mode === "login" ? t("login.submitSignIn") : t("login.submitRegister")}
        </button>
      </form>
      <button
        onClick={() => setMode(mode === "login" ? "register" : "login")}
        data-testid="login-toggle-mode"
        className="mt-4 text-sm text-zinc-600 hover:underline dark:text-zinc-400"
      >
        {mode === "login" ? t("login.toRegister") : t("login.toSignIn")}
      </button>
      <DemoLoginButton className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-800 [&>button]:w-full" />
    </main>
  );
}

export default function LoginPage() {
  if (PREVIEW) return <PreviewSignIn />;
  return (
    <Suspense>
      <AuthForm />
    </Suspense>
  );
}
