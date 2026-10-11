import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRight,
  BookOpen,
  FileText,
  Layers3,
  Loader2,
  LogOut,
  Search,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { GithubRepositoryPicker } from "@/components/github/repository-picker";
import { fetchJson, streamAnswer } from "@/lib/api";
import { englishMessage } from "@/lib/messages";
import { authClient } from "@/lib/auth-client";

const MarkdownAnswer = lazy(() => import("@/components/markdown-answer"));

type DocumentItem = {
  path: string;
  title: string;
  chunk_count: number;
};

type SourceItem = {
  chunk_id: string;
  source: string;
  section: string;
  score: number;
};

type SearchHit = {
  chunk: {
    chunk_id: string;
    source: string;
    section: string;
    text: string;
  };
  score: number;
  bm25_score: number;
  vector_score: number;
};

type SearchResult = {
  answer: string;
  sources: SourceItem[];
  hits: SearchHit[];
  document_count: number;
  chunk_count: number;
};

type AuthUser = {
  id: string;
  email: string;
  name?: string;
  image?: string | null;
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

type GithubStarsRagResult = {
  answer: string;
  sources: Array<{
    repository: string;
    url: string;
    score: number;
    bm25_score: number;
    vector_score: number;
  }>;
  hits: Array<{
    chunk: {
      chunk_id: string;
      source: string;
      section: string;
      text: string;
    };
    score: number;
    bm25_score: number;
    vector_score: number;
    evidence: string;
  }>;
  stars: GithubStar[];
  repository_count: number;
  filtered_repository_count: number;
  chunk_count: number;
  embedding_provider?: string;
  embedding_model?: string;
  pipeline: Array<{
    step: string;
    description: string;
  }>;
};

type GithubSyncStatus = {
  status:
    | "idle"
    | "queued"
    | "downloading_model"
    | "running"
    | "completed"
    | "failed"
    | "canceled";
  total: number;
  processed: number;
  indexed: number;
  progress: number;
  message: string;
  repository_count: number;
  chunk_count: number;
  embedding_provider?: string;
  embedding_model?: string;
  error?: string | null;
  reindex_required?: boolean;
};

type GithubStarsIndexResult = {
  stars: SyncedGithubStar[];
  total: number;
  limit: number;
  offset: number;
  embedding_provider?: string;
  embedding_model?: string;
};

type ResultDocument = {
  id: string;
  source: string;
  title: string;
  kind: "Document" | "GitHub";
  url?: string;
  passages: string[];
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search.q === "string" ? search.q : "",
  }),
  component: HomePage,
});

function HomePage() {
  const { q } = Route.useSearch();
  const navigate = useNavigate();
  const { data: session, isPending, refetch } = authClient.useSession();
  const user = session?.user;
  const [query, setQuery] = useState(q);
  const [loading, setLoading] = useState(false);
  const [generatedAnswer, setGeneratedAnswer] = useState("");
  const [answerLoading, setAnswerLoading] = useState(false);
  const [answerError, setAnswerError] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [githubResult, setGithubResult] = useState<GithubStarsRagResult | null>(
    null,
  );
  const [searchError, setSearchError] = useState("");
  const [reindexRequired, setReindexRequired] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [githubIndex, setGithubIndex] = useState<GithubStarsIndexResult | null>(
    null,
  );
  const [libraryError, setLibraryError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [githubSync, setGithubSync] = useState<GithubSyncStatus | null>(null);
  const [syncConnected, setSyncConnected] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{ repoId?: number } | null>(
    null,
  );
  const searchRequest = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  function openLogin() {
    void navigate({
      to: "/login",
      search: { redirect: q ? `/?q=${encodeURIComponent(q)}` : "/" },
    });
  }

  async function searchDocuments(value: string) {
    searchRequest.current?.abort();
    const request = new AbortController();
    searchRequest.current = request;
    setLoading(true);
    setGeneratedAnswer("");
    setAnswerError("");
    setAnswerLoading(false);
    setSearchError("");
    setResult(null);
    setGithubResult(null);
    const responses = await Promise.allSettled([
      fetchJson<SearchResult>("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: value, top_k: 5 }),
        signal: request.signal,
      }),
      fetchJson<GithubStarsRagResult>(
        `/api/github/stars?${new URLSearchParams({ query: value, limit: "10" })}`,
        { signal: request.signal },
      ),
    ]);
    if (request.signal.aborted) return;
    const [local, github] = responses;
    if (local.status === "fulfilled") setResult(local.value);
    if (github.status === "fulfilled") setGithubResult(github.value);
    const failures = responses.filter(
      (response) => response.status === "rejected",
    );
    if (failures.length) {
      setSearchError(
        failures.length === 2
          ? "Search is unavailable. Please try again."
          : `${local.status === "rejected" ? "Local documents" : "GitHub documents"} could not be searched. Showing available results.`,
      );
    }
    setLoading(false);
    const sources = collectResults(
      local.status === "fulfilled" ? local.value : null,
      github.status === "fulfilled" ? github.value : null,
    ).slice(0, 10);
    if (!sources.length) return;
    setAnswerLoading(true);
    try {
      await streamAnswer(
        {
          query: value.slice(0, 4000),
          sources: sources.map((source) => ({
            source: source.source.slice(0, 2048),
            title: source.title.slice(0, 512),
            passages: source.passages
              .slice(0, 4)
              .map((passage) => passage.slice(0, 4000)),
          })),
        },
        request.signal,
        (text) => {
          if (!request.signal.aborted) setGeneratedAnswer(text);
        },
      );
    } catch (error) {
      if (!request.signal.aborted) {
        setGeneratedAnswer("");
        setAnswerError(
          "Answer generation is unavailable. Showing retrieved evidence. " +
            englishMessage(error instanceof Error ? error.message : null),
        );
      }
    } finally {
      if (!request.signal.aborted) setAnswerLoading(false);
    }
  }

  useEffect(() => {
    setQuery(q);
    searchRequest.current?.abort();
    if (user && q.trim()) void searchDocuments(q.trim());
    else {
      setResult(null);
      setGithubResult(null);
      setLoading(false);
      setGeneratedAnswer("");
      setAnswerLoading(false);
      setAnswerError("");
      setSearchError("");
    }
    return () => searchRequest.current?.abort();
  }, [q, user?.id]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const next = query.trim();
    if (!next || isPending) return;
    if (!user) {
      void navigate({
        to: "/login",
        search: { redirect: `/?q=${encodeURIComponent(next)}` },
      });
    } else if (next === q) void searchDocuments(next);
    else void navigate({ to: "/", search: { q: next } });
  }

  useEffect(() => {
    if (!user) {
      setGithubSync(null);
      setSyncConnected(false);
      return;
    }
    let stopped = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const connect = () => {
      const url = new URL("/api/github/stars/sync/ws", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(url);
      socket = current;
      current.onopen = () => {
        if (!stopped) {
          attempts = 0;
          setSyncConnected(true);
        }
      };
      current.onmessage = (event) => {
        if (stopped) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === "sync.status") {
            setGithubSync(message.data);
            setReindexRequired(!!message.data.reindex_required);
          }
        } catch {
          if (import.meta.env.DEV)
            console.debug("[github-stars] Invalid sync event");
        }
      };
      current.onclose = () => {
        if (stopped) return;
        setSyncConnected(false);
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 30000));
      };
      current.onerror = () => current.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket.close();
    };
  }, [user?.id]);

  useEffect(() => {
    if (!libraryOpen || !user) return;
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
          "Some documents could not be loaded. Reopen the library to try again.",
        );
      setLibraryLoading(false);
    });
    return () => controller.abort();
  }, [
    libraryOpen,
    user?.id,
    githubSync?.repository_count,
    githubSync?.chunk_count,
    githubSync?.status,
  ]);

  async function startGithubSync(repositoryIds: number[]) {
    if (syncBusy || isGithubSyncActive(githubSync?.status))
      throw new Error(
        "An import is already running. Please wait or cancel it first.",
      );
    setSyncBusy(true);
    try {
      const status = await fetchJson<GithubSyncStatus>(
        "/api/github/stars/sync",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repositoryIds }),
        },
      );
      setGithubSync(status);
      setRepositoryPickerOpen(false);
      setLibraryOpen(true);
    } finally {
      setSyncBusy(false);
    }
  }

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
        if (q) void searchDocuments(q);
      }
    } catch (error) {
      setLibraryError(
        englishMessage(error instanceof Error ? error.message : null),
      );
    } finally {
      setSyncBusy(false);
    }
  }

  async function logout() {
    try {
      const response = await authClient.signOut();
      if (response.error)
        throw new Error(response.error.message || "Unable to sign out.");
      searchRequest.current?.abort();
      setLibraryOpen(false);
      setRepositoryPickerOpen(false);
      setConfirmation(null);
      setDocuments([]);
      setGithubIndex(null);
      setResult(null);
      setGithubResult(null);
      await refetch();
      void navigate({ to: "/login", search: { redirect: "/" } });
    } catch (error) {
      setSearchError(
        englishMessage(error instanceof Error ? error.message : null),
      );
    }
  }

  const results = collectResults(result, githubResult);
  const localAnswer = result?.hits.length ? result.answer : "";
  const answer =
    generatedAnswer ||
    localAnswer ||
    (githubResult?.hits.length ? githubResult.answer : "");
  const citations = generatedAnswer
    ? results.slice(0, 10).map((item, index) => ({
        source: item.source,
        title: item.title,
        number: index + 1,
      }))
    : localAnswer
      ? result?.sources.map((source, index) => ({
          title: source.section || source.source,
          source: source.source,
          number: index + 1,
        }))
      : githubResult?.sources.map((source, index) => ({
          title: source.repository,
          source: source.url,
          number: index + 1,
        }));
  const hasSearch = !!q.trim() && !!user;
  const activeImport = isGithubSyncActive(githubSync?.status);
  const searchForm = (
    <form className="bottle-search-form" role="search" onSubmit={submitSearch}>
      <Search size={21} aria-hidden="true" />
      <input
        ref={input}
        aria-label="Search documents"
        type="search"
        autoComplete="off"
        placeholder="Search documents or ask a question"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {query && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Clear search"
          onClick={() => {
            setQuery("");
            input.current?.focus();
          }}
        >
          <X size={17} />
        </Button>
      )}
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        aria-label={loading ? "Search again" : "Search"}
        disabled={!query.trim() || isPending}
      >
        {loading ? (
          <Loader2 className="animate-spin" size={20} />
        ) : (
          <Search size={20} />
        )}
      </Button>
    </form>
  );

  return (
    <main
      className={`bottle-search-page ${hasSearch ? "has-results" : "is-home"}`}
    >
      <header className="bottle-search-header">
        <button
          type="button"
          className="bottle-wordmark"
          aria-label="Bottle home"
          onClick={() => void navigate({ to: "/", search: { q: "" } })}
        >
          <Layers3 size={24} />
          <span>Bottle</span>
        </button>
        {hasSearch && <div className="bottle-header-search">{searchForm}</div>}
        <nav className="bottle-account-nav" aria-label="Account">
          {user ? (
            <>
              <Button variant="ghost" onClick={() => setLibraryOpen(true)}>
                <BookOpen size={16} />
                Library
                {activeImport && (
                  <span
                    className="bottle-import-dot"
                    aria-label="Import running"
                  />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Settings"
                title="Settings"
                onClick={() => void navigate({ to: "/settings" })}
              >
                <Settings size={17} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                title={`Sign out (${user.email})`}
                onClick={logout}
              >
                <LogOut size={17} />
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={isPending} onClick={openLogin}>
              {isPending ? "Loading…" : "Sign in"}
            </Button>
          )}
        </nav>
      </header>
      {!hasSearch ? (
        <section className="bottle-search-home" aria-label="Document search">
          <h1>
            Bottle<span>.</span>
          </h1>
          <p>Search documents. Get answers with sources.</p>
          {searchForm}
          <span className="bottle-search-hint">
            Your documents and imported GitHub content, one search away.
          </span>
          {searchError && (
            <p role="alert" className="bottle-search-warning">
              {searchError}
            </p>
          )}
        </section>
      ) : (
        <section className="bottle-search-results" aria-label="Search results">
          <h1 className="sr-only">Results for {q}</h1>
          <div className="bottle-results-label" role="status">
            {loading
              ? "Searching your documents…"
              : `${results.length} ${results.length === 1 ? "source" : "sources"} found`}
          </div>
          {searchError && (
            <div className="bottle-search-warning" role="alert">
              {searchError}{" "}
              <button type="button" onClick={() => void searchDocuments(q)}>
                Retry
              </button>
            </div>
          )}
          {loading ? (
            <div
              className="bottle-result-skeleton"
              role="status"
              aria-label="Searching"
            >
              <div />
              <div />
              <div />
            </div>
          ) : (
            <>
              {answerLoading && (
                <p
                  role="status"
                  className="mb-4 flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2 size={16} className="animate-spin" />
                  Writing an answer from your sources…
                </p>
              )}
              {answerError && (
                <p role="alert" className="bottle-search-warning">
                  {answerError}
                </p>
              )}
              {answer && (
                <section
                  className="bottle-answer"
                  aria-label={generatedAnswer ? "Answer" : "Answer draft"}
                >
                  <h2>
                    <Sparkles size={17} />
                    {generatedAnswer ? "Answer" : "Answer draft"}
                  </h2>
                  <Suspense
                    fallback={
                      <div className="bottle-answer-text">{answer}</div>
                    }
                  >
                    <MarkdownAnswer
                      text={answer}
                      streaming={!!generatedAnswer}
                      generating={answerLoading}
                    />
                  </Suspense>
                  <div className="bottle-citations">
                    {citations?.map((citation) => {
                      const target = results.find(
                        (item) => item.source === citation.source,
                      );
                      return target ? (
                        <a
                          key={`${citation.source}-${citation.number}`}
                          href={`#${target.id}`}
                        >
                          [{citation.number}] {citation.title}
                        </a>
                      ) : null;
                    })}
                  </div>
                  <p className="bottle-answer-note">
                    Based on{" "}
                    {generatedAnswer
                      ? "retrieved documents"
                      : localAnswer
                        ? "local documents"
                        : "imported GitHub documents"}
                    . Check the sources below.
                  </p>
                </section>
              )}
              {results.length ? (
                <div className="bottle-result-list">
                  {results.map((item) => (
                    <article
                      className="bottle-result"
                      id={item.id}
                      key={item.id}
                    >
                      <div className="bottle-result-source">
                        <FileText size={16} />
                        <span>
                          {item.kind}
                          <small>{item.source}</small>
                        </span>
                      </div>
                      <h2>
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.title}
                            <ArrowUpRight size={15} />
                          </a>
                        ) : (
                          item.title
                        )}
                      </h2>
                      <p className="bottle-result-excerpt">
                        {item.passages[0]}
                      </p>
                      <details className="bottle-result-passages">
                        <summary>
                          Read{" "}
                          {item.passages.length === 1
                            ? "passage"
                            : `${item.passages.length} passages`}
                        </summary>
                        {item.passages.map((passage, index) => (
                          <p key={index}>{passage}</p>
                        ))}
                      </details>
                    </article>
                  ))}
                </div>
              ) : (
                !searchError && (
                  <div className="bottle-no-results">
                    <h2>No matching documents</h2>
                    <p>
                      Try different keywords or add repositories through
                      Library.
                    </p>
                  </div>
                )
              )}
            </>
          )}
        </section>
      )}
      <footer className="bottle-search-footer">
        Bottle · Search documents. Answer with sources.
      </footer>
      <Dialog open={libraryOpen && !!user} onOpenChange={setLibraryOpen}>
        <DialogContent className="bottle-library-dialog sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Library</DialogTitle>
            <DialogDescription>
              Manage the documents available to search.
            </DialogDescription>
          </DialogHeader>
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
          <div className="bottle-library-scroll">
            <div className="bottle-library-heading">
              <h3>GitHub documents</h3>
              <Button
                size="sm"
                disabled={syncBusy || activeImport}
                onClick={() => {
                  setLibraryOpen(false);
                  setRepositoryPickerOpen(true);
                }}
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
            {!syncConnected && (
              <p className="bottle-library-muted">
                Live updates disconnected. Reconnecting…
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
              </div>
            ))}
            {!libraryLoading && !documents.length && (
              <p className="bottle-library-muted">
                No local documents indexed yet.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <GithubRepositoryPicker
        open={repositoryPickerOpen && !!user}
        onOpenChange={(open) => {
          setRepositoryPickerOpen(open);
          if (!open) setLibraryOpen(true);
        }}
        userId={user?.id || ""}
        onSync={startGithubSync}
        busy={syncBusy}
      />
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !syncBusy) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete{" "}
              {confirmation?.repoId ? "this repository" : "all imported data"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the imported content and indexed passages from
              Bottle. You can import them again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {libraryError && (
            <p role="alert" className="bottle-search-warning">
              {libraryError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncBusy}>Keep data</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={syncBusy}
              onClick={() => void mutateImport("delete", confirmation?.repoId)}
            >
              {syncBusy ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

function collectResults(
  local: SearchResult | null,
  github: GithubStarsRagResult | null,
): ResultDocument[] {
  const results = new Map<string, ResultDocument>();
  for (const hit of local?.hits || []) {
    const key = `local:${hit.chunk.source}`;
    const previous = results.get(key);
    if (previous) previous.passages.push(hit.chunk.text);
    else
      results.set(key, {
        id: `source-${results.size + 1}`,
        source: hit.chunk.source,
        title: hit.chunk.section || hit.chunk.source,
        kind: "Document",
        url: safeWebUrl(hit.chunk.source),
        passages: [hit.chunk.text],
      });
  }
  for (const hit of github?.hits || []) {
    const key = `github:${hit.chunk.source}`;
    const previous = results.get(key);
    if (previous) previous.passages.push(hit.evidence || hit.chunk.text);
    else
      results.set(key, {
        id: `source-${results.size + 1}`,
        source: hit.chunk.source,
        title: hit.chunk.section || hit.chunk.source,
        kind: "GitHub",
        url: safeWebUrl(hit.chunk.source),
        passages: [hit.evidence || hit.chunk.text],
      });
  }
  return [...results.values()];
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
