"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, atLeast, type DocumentItem, type DocumentStatus, type Me } from "@/lib/api";

const STATUS_STYLE: Record<DocumentStatus, string> = {
  queued: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  processing: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  ready: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const formatSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export default function DocumentsPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [docs, setDocs] = useState<DocumentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
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
    api<Me>("/auth/me").then(setMe).catch(() => router.replace("/login"));
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
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this document and its index?")) return;
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
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Documents</h1>
      <p className="mt-1 text-sm text-zinc-500">Upload PDFs, text or Markdown. They are chunked, embedded and indexed for AI search.</p>

      {canUpload && (
        <form onSubmit={upload} className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.markdown" required className="text-sm" />
          <button disabled={uploading} className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-60">
            {uploading ? "Uploading…" : "Upload"}
          </button>
          <span className="text-xs text-zinc-500">Max 10 MB</span>
        </form>
      )}

      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      <div className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-100 text-xs uppercase text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Size</th>
              <th className="px-4 py-2">Chunks</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {docs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                  No documents yet.
                </td>
              </tr>
            )}
            {docs.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-2">
                  <div className="font-medium">{d.title}</div>
                  <div className="text-xs text-zinc-500">{d.filename}</div>
                </td>
                <td className="px-4 py-2 text-zinc-500">{formatSize(d.sizeBytes)}</td>
                <td className="px-4 py-2 text-zinc-500">{d.chunkCount || "—"}</td>
                <td className="px-4 py-2">
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[d.status]}`} title={d.error ?? undefined}>
                    {d.status}
                  </span>
                  {d.error && <div className="mt-1 max-w-xs truncate text-xs text-red-600">{d.error}</div>}
                </td>
                <td className="space-x-3 px-4 py-2 text-right">
                  {isAdmin && (
                    <>
                      <button onClick={() => reindex(d.id)} className="text-xs text-zinc-600 hover:underline dark:text-zinc-400">
                        Reindex
                      </button>
                      <button onClick={() => remove(d.id)} className="text-xs text-red-600 hover:underline">
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
