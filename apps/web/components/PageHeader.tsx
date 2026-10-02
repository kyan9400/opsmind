/** Page wrapper and header shared by the dashboard pages, so every page has the same width and rhythm. */
export function Page({ children, width = "6xl" }: { children: React.ReactNode; width?: "4xl" | "6xl" }) {
  return (
    <main className={`mx-auto w-full ${width === "4xl" ? "max-w-4xl" : "max-w-6xl"} px-4 py-6 sm:px-6 lg:px-8 lg:py-8`}>
      {children}
    </main>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  titleTestId,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  titleTestId?: string;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-title font-semibold tracking-tight text-fg" data-testid={titleTestId}>
          {title}
        </h1>
        {description && <div className="mt-1 text-sm text-fg-muted">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Empty or zero state: icon tile, title, one line of help, optional action. */
export function EmptyState({
  icon,
  title,
  body,
  children,
  testId,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center" data-testid={testId}>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-brand-text">
        {icon}
      </span>
      <p className="mt-4 font-medium text-fg">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-fg-muted">{body}</p>}
      {children}
    </div>
  );
}
