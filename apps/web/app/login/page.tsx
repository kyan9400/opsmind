"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { demoEnabled, DemoLoginButton } from "@/components/DemoLoginButton";
import { IconAlert, IconArrowRight } from "@/components/icons";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Logo } from "@/components/Logo";
import { SandboxButton, sandboxEnabled } from "@/components/SandboxButton";
import { api, ApiError, setToken } from "@/lib/api";
import { registrationEnabled } from "@/lib/flags";
import { useT } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

/** Centered auth layout: logo above, card in the middle, a quiet way back home. */
function AuthShell({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <div className="relative flex min-h-screen flex-col">
      {/* Soft brand glow behind the card; purely decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(60%_100%_at_50%_0%,var(--brand-soft),transparent)]"
      />
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="btn btn-ghost btn-sm gap-1.5">
          <IconArrowRight size={15} className="ltr:-scale-x-100" />
          {t("login.backHome")}
        </Link>
        <LanguageSwitcher />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-4 pb-16">
        <Link href="/" className="mb-6 rounded-control" aria-label="OpsMind">
          <Logo size={34} />
        </Link>
        <div className="card w-full max-w-[25rem] p-6 shadow-raised sm:p-8">{children}</div>
      </main>
    </div>
  );
}

/** The static preview has one account, the read-only demo viewer: offer exactly that. */
function PreviewSignIn() {
  const t = useT();
  return (
    <AuthShell>
      <h1 className="text-xl font-semibold tracking-tight text-fg">{t("login.titleSignIn")}</h1>
      <p className="mt-2 text-sm text-fg-muted">{t("preview.loginHint")}</p>
      <DemoLoginButton size="lg" className="mt-6 [&>button]:w-full" />
    </AuthShell>
  );
}

function AuthForm() {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  // With sign-up closed, an old "Create workspace" link (?mode=register) opens the sign-in form.
  const [mode, setMode] = useState(registrationEnabled && params.get("mode") === "register" ? "register" : "login");
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
      // 403: the API has sign-up closed although this build shows the form (NEXT_PUBLIC_REGISTRATION unset).
      const closed = mode === "register" && err instanceof ApiError && err.status === 403;
      setError(closed ? t("login.registrationClosed") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <h1 className="text-xl font-semibold tracking-tight text-fg">
        {mode === "login" ? t("login.titleSignIn") : t("login.titleRegister")}
      </h1>
      <p className="mt-1.5 text-sm text-fg-muted">
        {mode === "login" ? t("login.subtitleSignIn") : t("login.subtitleRegister")}
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" data-testid="login-form">
        {mode === "register" && (
          <>
            <div>
              <label htmlFor="tenantName" className="label">
                {t("login.companyName")}
              </label>
              <input
                id="tenantName"
                name="tenantName"
                aria-label={t("login.companyName")}
                autoComplete="organization"
                required
                data-testid="login-tenant"
                className="input"
              />
            </div>
            <div>
              <label htmlFor="name" className="label">
                {t("login.yourName")}
              </label>
              <input
                id="name"
                name="name"
                aria-label={t("login.yourName")}
                autoComplete="name"
                required
                data-testid="login-name"
                className="input"
              />
            </div>
          </>
        )}
        <div>
          <label htmlFor="email" className="label">
            {t("login.email")}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            placeholder="name@company.com"
            aria-label={t("login.email")}
            autoComplete="email"
            required
            data-testid="login-email"
            className="input"
            dir="ltr"
          />
        </div>
        <div>
          <label htmlFor="password" className="label">
            {t("login.password")}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            aria-label={t("login.password")}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 8 : undefined}
            required
            data-testid="login-password"
            className="input"
          />
        </div>
        {error && (
          <p
            role="alert"
            data-testid="login-error"
            className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-text"
          >
            <IconAlert size={16} className="mt-0.5" />
            <span>{error}</span>
          </p>
        )}
        <button disabled={busy} data-testid="login-submit" className="btn btn-primary h-10 w-full">
          {busy ? "…" : mode === "login" ? t("login.submitSignIn") : t("login.submitRegister")}
        </button>
      </form>

      {registrationEnabled && (
        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          data-testid="login-toggle-mode"
          className="mt-4 w-full cursor-pointer text-center text-sm font-medium text-brand-text hover:underline"
        >
          {mode === "login" ? t("login.toRegister") : t("login.toSignIn")}
        </button>
      )}

      {(demoEnabled || sandboxEnabled) && (
        <>
          <div className="my-6 flex items-center gap-3 text-xs text-fg-subtle" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            {t("login.or")}
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="space-y-3">
            {demoEnabled && (
              <div className="rounded-control border border-brand-line bg-brand-soft p-4">
                <p className="text-sm font-semibold text-fg">{t("login.demoTitle")}</p>
                <p className="mt-1 text-sm text-fg-muted">{t("login.demoBody")}</p>
                <DemoLoginButton variant="primary" className="mt-3 [&>button]:w-full" />
              </div>
            )}
            {sandboxEnabled && (
              <div className="rounded-control border border-line bg-muted p-4">
                <p className="text-sm font-semibold text-fg">{t("sandbox.loginTitle")}</p>
                <p className="mt-1 text-sm text-fg-muted">{t("sandbox.loginBody")}</p>
                <SandboxButton variant="secondary" className="mt-3 [&>button]:w-full" />
              </div>
            )}
          </div>
        </>
      )}
    </AuthShell>
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
