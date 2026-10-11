import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2 } from "lucide-react";
import {
  GithubRepositoryPicker,
  type RepositorySelection,
} from "@/components/github/repository-picker";
import { authClient } from "@/lib/auth-client";
import { fetchJson } from "@/lib/api";

export const Route = createFileRoute("/import/github-stars")({
  head: () => ({ meta: [{ title: "Import GitHub Stars · Bottle" }] }),
  component: GithubStarsImportPage,
});

function GithubStarsImportPage() {
  const { data: session, isPending } = authClient.useSession();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isPending && !session?.user)
      void navigate({
        to: "/login",
        search: { redirect: "/import/github-stars" },
        replace: true,
      });
  }, [isPending, session?.user.id, navigate]);

  async function startImport(selection: RepositorySelection) {
    if (busy) return;
    setBusy(true);
    try {
      await fetchJson("/api/github/stars/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      await navigate({ to: "/library" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-svh bg-background px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto grid w-full max-w-3xl gap-7">
        <Link
          to="/library"
          className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          Back to Library
        </Link>
        <header>
          <p className="mb-2 text-sm font-semibold text-primary">Bottle</p>
          <h1 className="text-3xl font-semibold tracking-tight">
            Import from GitHub Stars
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Import descriptions and READMEs from selected repositories. Future
            refreshes use this selection. Other imported documents are kept.
          </p>
        </header>
        {session?.user ? (
          <GithubRepositoryPicker
            userId={session.user.id}
            onSync={startImport}
            busy={busy}
            onCancel={() => void navigate({ to: "/library" })}
          />
        ) : (
          <p role="status" className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" />
            {isPending ? "Loading your account…" : "Redirecting to sign in…"}
          </p>
        )}
      </div>
    </main>
  );
}
