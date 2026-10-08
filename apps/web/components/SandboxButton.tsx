"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight, IconUpload } from "@/components/icons";
import { api, ApiError, setToken } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import { PREVIEW } from "@/lib/preview";

// Inlined at build time. It mirrors the API's ALLOW_SANDBOX, so a deployment without sandboxes shows no
// button that can only fail. The static preview has no server to create a workspace on.
const flag = process.env.NEXT_PUBLIC_SANDBOX;
export const sandboxEnabled = !PREVIEW && (flag === "1" || flag === "true");

/** Creates a temporary private workspace (owner role, sample data) and opens its Documents page. */
export function SandboxButton({
  className = "",
  variant = "soft",
  size = "md",
}: {
  className?: string;
  variant?: "primary" | "soft" | "secondary";
  size?: "md" | "lg";
}) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sandboxEnabled) return null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const { token } = await api<{ token: string; expiresAt: string }>("/sandbox", { method: "POST" });
      setToken(token);
      // Documents first: the sample files index in the background there, next to the upload form.
      router.push("/dashboard/documents");
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 429 ? t("sandbox.rateLimited") : status === 503 ? t("sandbox.busy") : (err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={start}
        disabled={busy}
        data-testid="sandbox-start"
        // Wraps instead of spilling over its edges when a label is too long for a narrow phone; min-h keeps
        // the usual height for one line.
        className={`btn ${size === "lg" ? "btn-lg min-h-11" : "min-h-9"} btn-${variant} group h-auto max-w-full py-1.5 text-center whitespace-normal [&>svg]:shrink-0`}
      >
        <IconUpload size={size === "lg" ? 18 : 16} />
        {busy ? t("sandbox.loading") : t("sandbox.button")}
        <IconArrowRight
          size={16}
          className="opacity-70 transition-transform ltr:group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
        />
      </button>
      {error && (
        <p role="alert" data-testid="sandbox-error" className="mt-2 text-sm text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
