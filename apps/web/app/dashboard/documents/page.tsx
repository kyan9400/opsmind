"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconAlert, IconDocuments, IconRefresh, IconTrash, IconUpload } from "@/components/icons";
import { EmptyState, Page, PageHeader } from "@/components/PageHeader";
import { api, ApiError, atLeast, type DocumentItem, type DocumentStatus, type Me } from "@/lib/api";
import { formatNumber } from "@/lib/format";
import type { Locale } from "@/lib/i18n/config";
import { useI18n } from "@/lib/i18n/provider";
import type { Translator } from "@/lib/i18n/types";

const STATUS_STYLE: Record<DocumentStatus, { badge: string; dot: string }> = {
  queued: { badge: "badge-neutral", dot: "bg-fg-subtle" },
  processing: { badge: "badge-warning", dot: "bg-warning motion-safe:animate-pulse" },
  ready: { badge: "badge-success", dot: "bg-success" },
  failed: { badge: "badge-danger", dot: "bg-danger" },
};

function formatSize(b: number, t: Translator, locale: Locale): string {
  const oneDecimal = (v: number) => formatNumber(v, locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (b < 1024) return t("size.b", { n: formatNumber(b, locale) });
  if (b < 1048576) return t("size.kb", { n: oneDecimal(b / 1024) });
  return t("size.mb", { n: oneDecimal(b / 1048576) });
}

export default function DocumentsPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setDocs((await api<{ data: DocumentItem[] }>("/documents")).data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return router.replace("/login");
      setError((err as Error).message);
    }
  }, [router]);

  useEffect(() => {
    api<Me>("/auth/me")
      .then(setMe)
      .catch(() => router.replace("/login"));
    load();
  }, [load, router]);

  // Poll while anything is still being indexed.
  const pending = docs.some((d) => d.status === "queued" || d.status === "processing");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [pending, load]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    const body = new FormData();
    body.append("file", file);
    try {
      await api("/documents", { method: "POST", body });
      if (fileRef.current) fileRef.current.value = "";
      setFileName(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    if (!confirm(t("docs.confirmDelete"))) return;
    await api(`/documents/${id}`, { method: "DELETE" }).catch((err) => setError(err.message));
    load();
  }

  async function reindex(id: string) {
    await api(`/documents/${id}/reindex`, { method: "POST" }).catch((err) => setError(err.message));
    load();
  }

  const canUpload = me && atLeast(me.role, "member");
  const isAdmin = me && atLeast(me.role, "admin");

  return (
    <Page>
      <PageHeader title={t("docs.title")} description={t("docs.subtitle")} />

      {canUpload && (
        <form
          onSubmit={upload}
          data-testid="doc-upload-form"
          className="mt-6 flex flex-col gap-4 rounded-card border border-dashed border-line-strong bg-surface p-5 sm:flex-row sm:items-center"
        >
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand-text">
            <IconUpload size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">{t("docs.uploadTitle")}</p>
            <p className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-sm text-fg-muted">
              <span
                className={`max-w-full truncate ${fileName ? "font-medium text-fg" : "text-fg-muted"}`}
                data-testid="doc-upload-filename"
              >
                {fileName ?? t("docs.noFile")}
              </span>
              <span className="text-fg-subtle">
                {t("docs.formats")} · {t("docs.maxSize")}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {/* The native picker text ("Choose file / No file chosen") follows the browser language rather
                than the app's, so the input is visually hidden (still focusable and validated) behind a label. */}
            <label className="btn btn-secondary focus-within:ring-2 focus-within:ring-ring">
              {t("docs.chooseFile")}
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.txt,.md,.markdown"
                required
                data-testid="doc-upload-input"
                onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
                className="sr-only"
              />
            </label>
            <button disabled={uploading} data-testid="doc-upload-submit" className="btn btn-primary">
              {uploading ? t("docs.uploading") : t("docs.upload")}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p
          role="alert"
          className="mt-4 flex items-center gap-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-text"
        >
          <IconAlert size={16} />
          {error}
        </p>
      )}

      <div className="card mt-6 overflow-x-auto">
        <table className="w-full text-sm" data-testid="doc-table">
          <thead className="border-b border-line bg-muted/60 text-xs font-medium text-fg-muted">
            <tr>
              <th className="px-5 py-2.5 text-start font-medium">{t("docs.colTitle")}</th>
              <th className="px-4 py-2.5 text-start font-medium">{t("docs.colSize")}</th>
              <th className="px-4 py-2.5 text-start font-medium">{t("docs.colChunks")}</th>
              <th className="px-4 py-2.5 text-start font-medium">{t("docs.colStatus")}</th>
              <th className="px-5 py-2.5">
                <span className="sr-only">{t("docs.colActions")}</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {docs.length === 0 && (
              <tr>
                <td colSpan={5} data-testid="doc-empty">
                  <EmptyState icon={<IconDocuments size={22} />} title={t("docs.empty")} body={t("docs.emptyHint")} />
                </td>
              </tr>
            )}
            {docs.map((d) => (
              <tr key={d.id} data-testid="doc-row" data-doc-id={d.id} className="transition-colors hover:bg-muted/50">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line bg-muted text-fg-subtle">
                      <IconDocuments size={17} />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-fg">{d.title}</div>
                      <div className="truncate text-xs text-fg-subtle">{d.filename}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-fg-muted tabular-nums">
                  {formatSize(d.sizeBytes, t, locale)}
                </td>
                <td className="px-4 py-3 text-fg-muted tabular-nums">
                  {d.chunkCount ? formatNumber(d.chunkCount, locale) : "—"}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`badge ${STATUS_STYLE[d.status].badge}`}
                    title={d.error ?? undefined}
                    data-testid="doc-status"
                    data-status={d.status}
                  >
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${STATUS_STYLE[d.status].dot}`} />
                    {t(`docs.status.${d.status}`)}
                  </span>
                  {d.error && <div className="mt-1 max-w-xs truncate text-xs text-danger-text">{d.error}</div>}
                </td>
                <td className="px-5 py-3 text-end">
                  {isAdmin && (
                    <div className="inline-flex gap-1">
                      <button onClick={() => reindex(d.id)} data-testid="doc-reindex" className="btn btn-ghost btn-sm">
                        <IconRefresh size={14} />
                        {t("docs.reindex")}
                      </button>
                      <button
                        onClick={() => remove(d.id)}
                        data-testid="doc-delete"
                        className="btn btn-danger-ghost btn-sm"
                      >
                        <IconTrash size={14} />
                        {t("docs.delete")}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}
