"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, setToken } from "@/lib/api";

function AuthForm() {
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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold">{mode === "login" ? "Sign in to OpsMind" : "Create your workspace"}</h1>
      <form onSubmit={onSubmit} className="mt-6 space-y-3">
        {mode === "register" && (
          <>
            <input name="tenantName" placeholder="Company name" required className={input} />
            <input name="name" placeholder="Your name" required className={input} />
          </>
        )}
        <input name="email" type="email" placeholder="Email" autoComplete="email" required className={input} />
        <input
          name="password"
          type="password"
          placeholder="Password (min 8 chars)"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={mode === "register" ? 8 : undefined}
          required
          className={input}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full rounded-lg bg-indigo-600 py-2 text-white hover:bg-indigo-500 disabled:opacity-60">
          {busy ? "…" : mode === "login" ? "Sign in" : "Create workspace"}
        </button>
      </form>
      <button
        onClick={() => setMode(mode === "login" ? "register" : "login")}
        className="mt-4 text-sm text-zinc-600 hover:underline dark:text-zinc-400"
      >
        {mode === "login" ? "New here? Create a workspace" : "Already have an account? Sign in"}
      </button>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <AuthForm />
    </Suspense>
  );
}
