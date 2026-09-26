import Link from "next/link";

const features = [
  { title: "Cited AI answers", body: "Ask questions over your company documents and get answers that link back to the source." },
  { title: "Live KPI dashboards", body: "Operational metrics in one place, with AI hints when something looks off." },
  { title: "Built for teams", body: "Multi-tenant workspaces, role-based access, and a full audit trail." },
];

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-medium text-indigo-600 dark:text-indigo-400">OpsMind</p>
      <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
        Your operations and company knowledge, in one AI-native workspace.
      </h1>
      <div className="mt-8 flex gap-3">
        <Link href="/login?mode=register" className="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500">
          Create workspace
        </Link>
        <Link href="/login" className="rounded-lg border border-zinc-300 px-4 py-2 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Sign in
        </Link>
      </div>
      <div className="mt-16 grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
            <h2 className="font-medium">{f.title}</h2>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{f.body}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
