import { createFileRoute, Link, useNavigate, useBlocker } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Cable, Search, FileText, Layers, ChevronRight } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { EmbeddingSettings } from "@/components/settings/embedding-settings";
import { LlmSettings } from "@/components/settings/llm-settings";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings · Bottle" }] }),
  component: SettingsPage,
});
const categories = [
  { id: "connection", title: "Model connection", description: "API, credentials & connection", icon: Cable },
  { id: "search", title: "Search & answers", description: "Relevance, speed & generation", icon: Search },
  { id: "preprocessing", title: "Document preprocessing", description: "Source summaries & prompts", icon: FileText },
  { id: "embedding", title: "Embedding model", description: "Provider, vectors & indexing", icon: Layers },
] as const;

function SettingsPage() {
  const [category, setCategory] = useState<(typeof categories)[number]["id"]>("connection");
  const [llmPending, setLlmPending] = useState(false);
  const [embeddingPending, setEmbeddingPending] = useState(false);
  const pending = llmPending || embeddingPending;
  const blocker = useBlocker({ shouldBlockFn: () => pending, enableBeforeUnload: () => pending, withResolver: true });
  useEffect(() => {
    if (!pending && blocker.status === "blocked") blocker.proceed();
  }, [pending, blocker]);
  const selected = categories.find((item) => item.id === category)!;
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
      <div className="mx-auto grid w-full max-w-6xl gap-7">
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
            Your account preferences. Changes are saved automatically.
          </p>
        </header>
        {blocker.status === "blocked" && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 text-sm">
            <p className="mr-auto">Changes have not been saved yet. Stay to finish saving, or leave and discard the draft.</p>
            <button type="button" className="rounded-md border px-3 py-2" onClick={blocker.reset}>Stay here</button>
            <button type="button" className="rounded-md border px-3 py-2 text-destructive" onClick={blocker.proceed}>Leave page</button>
          </div>
        )}
        {session?.user ? (
          <div className="grid items-start gap-6 md:grid-cols-[240px_minmax(0,1fr)] md:gap-10">
            <nav aria-label="Settings categories" className="flex gap-2 overflow-x-auto pb-2 md:sticky md:top-8 md:grid md:overflow-visible">
              {categories.map(({ id, title, description, icon: Icon }) => (
                <button key={id} type="button" aria-current={category === id ? "page" : undefined}
                  onClick={() => setCategory(id)}
                  className={`flex shrink-0 items-center gap-3 rounded-lg border px-3 py-3 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary md:w-full ${category === id ? "border-primary/15 bg-primary/10 text-primary" : "border-transparent hover:bg-muted"}`}>
                  <Icon size={18} className="shrink-0" />
                  <span><span className="block font-medium">{title}</span><span className="mt-1 hidden text-xs text-muted-foreground md:block">{description}</span></span>
                </button>
              ))}
            </nav>
            <div className="min-w-0">
              <div className="mb-5 flex items-center gap-2 text-sm text-muted-foreground">
                <span>Settings</span><ChevronRight size={14} /><span className="text-foreground">{selected.title}</span>
              </div>
              <div hidden={category === "embedding"}>
                <LlmSettings onPendingChange={setLlmPending} section={category === "embedding" ? "connection" : category} />
              </div>
              <div hidden={category !== "embedding"}><EmbeddingSettings onPendingChange={setEmbeddingPending} /></div>
            </div>
          </div>
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
