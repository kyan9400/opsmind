"use client";

import { useEffect, useState } from "react";
import { IconInfo } from "@/components/icons";
import { useT } from "@/lib/i18n/provider";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Pinned above every dashboard page of a sandbox workspace, so nobody mistakes it for a real account:
 * it says the workspace is temporary and how long it has left (whole hours, rounded down).
 */
export function SandboxBanner({ expiresAt }: { expiresAt: string }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

  // A minute is plenty for an hour-level countdown.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const hours = Math.floor((new Date(expiresAt).getTime() - now) / HOUR_MS);

  return (
    <div
      role="status"
      data-testid="sandbox-banner"
      data-hours={Math.max(hours, 0)}
      // Sticks under the sticky top bar (h-14), so it stays in view on long pages. Opaque surface underneath:
      // --brand-soft is translucent in dark mode.
      className="sticky top-14 z-20 border-b border-brand-line bg-surface text-brand-soft-fg [background-image:linear-gradient(var(--brand-soft),var(--brand-soft))]"
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6 lg:px-8">
        <span className="flex items-center gap-2 font-semibold">
          <IconInfo size={16} />
          {hours >= 1 ? t("sandbox.banner", { count: hours }) : t("sandbox.bannerSoon")}
        </span>
        {/* Sticky, so keep it to one line on phones. */}
        <span className="hidden text-fg-muted sm:inline">{t("sandbox.bannerHint")}</span>
      </p>
    </div>
  );
}
