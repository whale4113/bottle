import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { EmbeddingSettings } from "@/components/settings/embedding-settings";
import { LlmSettings } from "@/components/settings/llm-settings";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings · Bottle" }] }),
  component: SettingsPage,
});
function SettingsPage() {
  const { data: session, isPending } = authClient.useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (!isPending && !session?.user)
      void navigate({
        to: "/login",
        search: { redirect: "/settings" },
        replace: true,
      });
  }, [isPending, session?.user.id, navigate]);
  return (
    <main className="min-h-svh bg-background px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto grid w-full max-w-2xl gap-7">
        <Link
          to="/"
          search={{ q: "" }}
          className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          Back to search
        </Link>
        <header>
          <p className="mb-2 text-sm font-semibold text-primary">Bottle</p>
          <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Configure models for document processing, retrieval, and generation.
            Settings apply only to your account.
          </p>
        </header>
        {session?.user ? (
          <>
            <LlmSettings />
            <EmbeddingSettings />
          </>
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
