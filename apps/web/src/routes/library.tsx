import { EmbeddingViewer } from "@/components/library/embedding-viewer";
import { useGithubSync, type GithubSyncStatus } from "@/lib/use-github-sync";
import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { fetchJson } from "@/lib/api";
import { englishMessage } from "@/lib/messages";
type DocumentItem = {
  path: string;
  title: string;
  chunk_count: number;
};

type GithubStar = {
  id: number | string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  language: string | null;
  stargazersCount: number;
  updatedAt: string;
  topics: string[];
  owner: {
    login: string;
    avatarUrl: string;
  };
};

type SyncedGithubStar = GithubStar & {
  repoId: number;
  syncedAt: number;
  readmeLength: number;
  chunkCount: number;
};

type GithubStarsIndexResult = {
  stars: SyncedGithubStar[];
  total: number;
  limit: number;
  offset: number;
  embedding_provider?: string;
  embedding_model?: string;
};

export const Route = createFileRoute("/library")({
  head: () => ({ meta: [{ title: "Library · Bottle" }] }),
  component: LibraryPage,
});
function LibraryPage() {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;
  const navigate = useNavigate();
  const [embeddingView, setEmbeddingView] = useState<{ url: string; title: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [reindexRequired, setReindexRequired] = useState(false);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [githubIndex, setGithubIndex] = useState<GithubStarsIndexResult | null>(
    null,
  );
  const [libraryError, setLibraryError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const { githubSync, setGithubSync, syncAvailable } = useGithubSync(user?.id);
  const [syncBusy, setSyncBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ repoId?: number } | null>(
    null,
  );
  useEffect(() => {
    if (!isPending && !user)
      void navigate({
        to: "/login",
        search: { redirect: "/library" },
        replace: true,
      });
  }, [isPending, user?.id, navigate]);

  useEffect(() => {
    setReindexRequired(!!githubSync?.reindex_required);
  }, [githubSync?.reindex_required]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setLibraryLoading(true);
    setLibraryError("");
    void Promise.allSettled([
      fetchJson<{ documents: DocumentItem[] }>("/api/documents", {
        signal: controller.signal,
      }),
      fetchJson<GithubStarsIndexResult>(
        "/api/github/stars/index?limit=100&offset=0",
        { signal: controller.signal },
      ),
    ]).then(([local, github]) => {
      if (controller.signal.aborted) return;
      if (local.status === "fulfilled") setDocuments(local.value.documents);
      if (github.status === "fulfilled") setGithubIndex(github.value);
      if (local.status === "rejected" || github.status === "rejected")
        setLibraryError(
          "Some documents could not be loaded. Try loading the library again.",
        );
      setLibraryLoading(false);
    });
    return () => controller.abort();
  }, [
    user?.id,
    githubSync?.repository_count,
    githubSync?.chunk_count,
    githubSync?.status,
    reload,
  ]);

  async function mutateImport(action: "cancel" | "delete", repoId?: number) {
    if (syncBusy) return;
    setSyncBusy(true);
    setLibraryError("");
    try {
      const path =
        action === "cancel"
          ? "/api/github/stars/sync/cancel"
          : repoId
            ? `/api/github/stars/repositories/${repoId}/reset`
            : "/api/github/stars/sync/reset";
      const response = await fetchJson<
        GithubSyncStatus | { sync: GithubSyncStatus }
      >(path, { method: "POST" });
      setGithubSync("sync" in response ? response.sync : response);
      if (action === "delete") {
        setConfirmation(null);
        setGithubIndex(
          (previous) =>
            previous && {
              ...previous,
              stars: repoId
                ? previous.stars.filter((star) => star.repoId !== repoId)
                : [],
              total: repoId ? Math.max(0, previous.total - 1) : 0,
            },
        );
      }
    } catch (error) {
      setLibraryError(
        englishMessage(error instanceof Error ? error.message : null),
      );
    } finally {
      setSyncBusy(false);
    }
  }

  useEffect(() => {
    if (confirmation)
      document
        .getElementById("delete-heading")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [confirmation]);
  const activeImport = isGithubSyncActive(githubSync?.status);
  return (
    <main className="min-h-svh bg-background px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto grid w-full max-w-3xl gap-7">
        <nav className="flex items-center justify-between gap-3">
          <Link
            to="/"
            search={{ q: "" }}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={16} />
            Back to search
          </Link>
          <Link
            to="/settings"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Settings
          </Link>
        </nav>
        <header>
          <p className="mb-2 text-sm font-semibold text-primary">Bottle</p>
          <h1 className="text-3xl font-semibold tracking-tight">Library</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Manage the documents available to search.
          </p>
        </header>
        {!user ? (
          <p role="status" className="flex items-center gap-2">
            <Loader2 size={16} className="animate-spin" />
            {isPending ? "Loading your account…" : "Redirecting to sign in…"}
          </p>
        ) : (
          <>
            {libraryError && (
              <p role="alert" className="bottle-search-warning">
                {libraryError}
              </p>
            )}
            {(reindexRequired || githubSync?.reindex_required) && (
              <p className="bottle-search-warning" role="status">
                Your embedding model has changed. Reimport GitHub documents to
                make them searchable with this model.
              </p>
            )}
            <div className="grid gap-3">
              <div className="bottle-library-heading">
                <h3>GitHub documents</h3>
                <Button
                  size="sm"
                  disabled={syncBusy || activeImport}
                  onClick={() => void navigate({ to: "/import/github-stars" })}
                >
                  Import GitHub Stars
                </Button>
              </div>

              {githubSync && (
                <div className="bottle-library-progress">
                  <span>{formatGithubSyncProgress(githubSync)}</span>
                  {activeImport && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={syncBusy}
                      onClick={() => void mutateImport("cancel")}
                    >
                      Cancel import
                    </Button>
                  )}
                  {activeImport && (
                    <progress
                      max={100}
                      value={githubSync.progress}
                      aria-label="GitHub import progress"
                    />
                  )}
                  {githubSync.error && (
                    <p role="alert">{englishMessage(githubSync.error)}</p>
                  )}
                </div>
              )}
              {!syncAvailable && (
                <p className="bottle-library-muted">
                  Unable to refresh import progress. Retrying…
                </p>
              )}
              {libraryLoading && (
                <p role="status" className="bottle-library-muted">
                  Loading documents…
                </p>
              )}
              {!libraryLoading && !githubIndex?.stars.length && (
                <p className="bottle-library-muted">
                  Import selected repositories to search their descriptions and
                  READMEs.
                </p>
              )}
              {githubIndex?.stars.map((star) => (
                <div className="bottle-library-item" key={star.repoId}>
                  <div>
                    <a
                      href={safeWebUrl(star.htmlUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {star.fullName}
                    </a>
                    <small>{star.chunkCount} indexed passages</small>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEmbeddingView({ url: `/api/github/stars/repositories/${star.repoId}/embeddings`, title: star.fullName })}>View embeddings</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Delete ${star.fullName}`}
                    disabled={syncBusy || activeImport}
                    onClick={() => setConfirmation({ repoId: star.repoId })}
                  >
                    Delete
                  </Button>
                </div>
              ))}
              {!!githubIndex?.total && (
                <div className="bottle-library-heading">
                  <small className="bottle-library-muted">
                    {githubIndex.total} imported repositories
                    {githubIndex.total > githubIndex.stars.length
                      ? ` · showing the first ${githubIndex.stars.length}`
                      : ""}
                  </small>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={syncBusy || activeImport}
                    onClick={() => setConfirmation({})}
                  >
                    Delete all
                  </Button>
                </div>
              )}
              <h3 className="bottle-library-local-heading">Local documents</h3>
              {documents.map((document) => (
                <div className="bottle-library-item" key={document.path}>
                  <FileText size={16} />
                  <div>
                    <strong>{document.title}</strong>
                    <small>
                      {document.path} · {document.chunk_count} passages
                    </small>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEmbeddingView({ url: `/api/documents/embeddings?${new URLSearchParams({ source: document.path })}`, title: document.title })}>View embeddings</Button>
                </div>
              ))}
              {!libraryLoading && !documents.length && (
                <p className="bottle-library-muted">
                  No local documents indexed yet.
                </p>
              )}
            </div>
            {libraryError && (
              <Button
                variant="outline"
                className="w-fit"
                disabled={libraryLoading}
                onClick={() => setReload((value) => value + 1)}
              >
                Retry loading documents
              </Button>
            )}
            {embeddingView && user && <EmbeddingViewer key={`${user.id}:${embeddingView.url}`} {...embeddingView} onClose={() => setEmbeddingView(null)} />}
            {confirmation && (
              <section
                className="grid gap-3 rounded-xl border border-destructive/30 bg-card p-5"
                aria-labelledby="delete-heading"
              >
                <h2 id="delete-heading" className="font-semibold">
                  Delete{" "}
                  {confirmation.repoId
                    ? "this repository"
                    : "all imported data"}
                  ?
                </h2>
                <p className="text-sm text-muted-foreground">
                  This removes imported content and indexed passages from
                  Bottle. You can import them again later.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={syncBusy}
                    onClick={() => setConfirmation(null)}
                  >
                    Keep data
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={syncBusy}
                    onClick={() =>
                      void mutateImport("delete", confirmation.repoId)
                    }
                  >
                    {syncBusy ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
function safeWebUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isGithubSyncActive(status: GithubSyncStatus["status"] | undefined) {
  return (
    status === "queued" ||
    status === "downloading_model" ||
    status === "running"
  );
}

function formatGithubSyncProgress(sync: GithubSyncStatus) {
  if (sync.status === "canceled") {
    return `${englishMessage(sync.message, syncStatusLabel(sync.status))} · Indexed passages: ${sync.indexed}`;
  }
  const indexingProgress =
    sync.total > 0
      ? `${sync.processed}/${sync.total}`
      : sync.processed > 0
        ? `Fetched ${sync.processed} repositories`
        : "Waiting for repositories";
  return `${englishMessage(sync.message, syncStatusLabel(sync.status))} · ${indexingProgress} · Indexed passages: ${sync.indexed}`;
}

function syncStatusLabel(status: GithubSyncStatus["status"]) {
  const labels = {
    idle: "Not imported",
    queued: "Queued",
    downloading_model: "Preparing search model",
    running: "Importing",
    completed: "Imported",
    failed: "Import failed",
    canceled: "Canceled",
  };
  return labels[status];
}
