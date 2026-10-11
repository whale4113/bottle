import { englishMessage } from "@/lib/messages";
import { GithubRepositoryPicker } from "@/components/github/repository-picker";
import { fetchJson } from "@/lib/api";
import {
  ArrowUpRight,
  BookOpen,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  Layers3,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  MessagesSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { authClient } from "../lib/auth-client";

function Github({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.29-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15A10.8 10.8 0 0 1 12 6.17c.96 0 1.92.13 2.82.38 2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.27-5.14 5.55.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z" />
    </svg>
  );
}

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
};

type GithubStarsIndexResult = {
  stars: SyncedGithubStar[];
  total: number;
  limit: number;
  offset: number;
  embedding_provider?: string;
  embedding_model?: string;
};

const EXAMPLE_QUERIES = [
  "Why does RAG use hybrid search?",
  "How does reranking improve search results?",
  "When should I combine SQL and vector search?",
];

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const navigate = useNavigate();
  function openLogin() {
    void navigate({ to: "/login", search: { redirect: "/" } });
  }
  const {
    data: session,
    isPending: sessionPending,
    refetch: refetchSession,
  } = authClient.useSession();
  const [workspace, setWorkspace] = useState<"knowledge" | "github">(
    "knowledge",
  );
  const [syncBusy, setSyncBusy] = useState(false);
  const [repositoryPickerOpen, setRepositoryPickerOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ repoId?: number } | null>(
    null,
  );
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [status, setStatus] = useState<
    "connecting" | "ok" | "loading" | "error"
  >("connecting");
  const [error, setError] = useState("");
  const [githubQuery, setGithubQuery] = useState("");
  const [githubResult, setGithubResult] = useState<GithubStarsRagResult | null>(
    null,
  );
  const [githubStatus, setGithubStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [githubError, setGithubError] = useState("");
  const [syncConnected, setSyncConnected] = useState(false);
  const [githubSync, setGithubSync] = useState<GithubSyncStatus | null>(null);
  const [githubIndex, setGithubIndex] = useState<GithubStarsIndexResult | null>(
    null,
  );

  const chunkCount = documents.reduce(
    (sum, doc) => sum + Number(doc.chunk_count || 0),
    0,
  );
  const user = session?.user as AuthUser | undefined;

  async function runSyncAction(action: () => Promise<void>) {
    if (syncBusy) return;
    setSyncBusy(true);
    try {
      await action();
    } finally {
      setSyncBusy(false);
    }
  }

  async function loadSession() {
    if (sessionPending) {
      return;
    }
    if (user) {
      await loadDocuments(false);

      return;
    }
    setStatus("ok");
  }

  async function logout() {
    try {
      const response = await authClient.signOut();
      if (response.error)
        throw new Error(
          response.error.message || "Unable to sign out. Please try again.",
        );
      await refetchSession();
      setDocuments([]);
      setResult(null);
      setGithubResult(null);
      setGithubSync(null);
      setGithubIndex(null);
      setRepositoryPickerOpen(false);
      setStatus("ok");
    } catch (requestError) {
      setError(getErrorMessage(requestError));
    }
  }

  async function loadDocuments(requireUser = true) {
    if (requireUser && !user) {
      return;
    }
    setStatus("connecting");
    setError("");
    try {
      const payload = await fetchJson<{ documents: DocumentItem[] }>(
        "/api/documents",
      );
      setDocuments(payload.documents || []);
      setStatus("ok");
    } catch (requestError) {
      setStatus("error");
      setError(getErrorMessage(requestError));
    }
  }

  async function submitSearch(nextQuery = query) {
    if (status === "loading") return;
    const normalizedQuery = nextQuery.trim();
    if (!normalizedQuery) {
      return;
    }
    if (!user) {
      openLogin();
      return;
    }

    setQuery(normalizedQuery);
    setStatus("loading");
    setError("");

    try {
      const payload = await fetchJson<SearchResult>("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: normalizedQuery, top_k: topK }),
      });
      setResult(payload);
      setStatus("ok");
    } catch (requestError) {
      setResult(null);
      setStatus("error");
      setError(getErrorMessage(requestError));
    }
  }

  async function searchGithubStars() {
    if (githubStatus === "loading") return;
    if (!user) {
      setGithubError("Sign in to search imported GitHub documents.");
      return;
    }
    if (!githubQuery.trim()) {
      setGithubError(
        "Enter a question or keywords to search imported documents.",
      );
      return;
    }

    setGithubStatus("loading");
    setGithubError("");

    try {
      const params = new URLSearchParams({
        query: githubQuery.trim(),
        limit: "20",
      });
      const payload = await fetchJson<GithubStarsRagResult>(
        `/api/github/stars?${params.toString()}`,
      );
      setGithubResult(payload);
      setGithubStatus("idle");
    } catch (requestError) {
      setGithubResult(null);
      setGithubStatus("error");
      setGithubError(getErrorMessage(requestError));
    }
  }

  async function loadGithubIndex() {
    if (!user) {
      return;
    }
    try {
      const params = new URLSearchParams({
        limit: "50",
        offset: "0",
      });
      const payload = await fetchJson<GithubStarsIndexResult>(
        `/api/github/stars/index?${params.toString()}`,
      );
      setGithubIndex(payload);
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError));
      setGithubIndex(null);
    }
  }

  async function startGithubSync(repositoryIds: number[]) {
    if (syncBusy || isGithubSyncActive(githubSync?.status))
      throw new Error(
        "An import is already running. Please wait or cancel it first.",
      );
    setSyncBusy(true);
    setGithubError("");
    try {
      const payload = await fetchJson<GithubSyncStatus>(
        "/api/github/stars/sync",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repositoryIds }),
        },
      );
      setGithubSync(payload);
      setRepositoryPickerOpen(false);
    } finally {
      setSyncBusy(false);
    }
  }

  async function resetGithubSync() {
    setGithubError("");
    try {
      const payload = await fetchJson<GithubSyncStatus>(
        "/api/github/stars/sync/reset",
        { method: "POST" },
      );
      setGithubSync(payload);
      setGithubIndex(null);
      setGithubResult(null);
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError));
    }
  }

  async function resetGithubRepository(repoId: number) {
    setGithubError("");
    try {
      const payload = await fetchJson<{ sync: GithubSyncStatus }>(
        `/api/github/stars/repositories/${repoId}/reset`,
        { method: "POST" },
      );
      setGithubSync(payload.sync);
      setGithubResult(null);
      await loadGithubIndex();
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError));
    }
  }

  async function cancelGithubSync() {
    setGithubError("");
    try {
      const payload = await fetchJson<GithubSyncStatus>(
        "/api/github/stars/sync/cancel",
        { method: "POST" },
      );
      setGithubSync(payload);
    } catch (requestError) {
      setGithubError(getErrorMessage(requestError));
    }
  }

  useEffect(() => {
    loadSession();
  }, [sessionPending, user?.id]);

  useEffect(() => {
    if (!user) {
      setGithubSync(null);
      setGithubIndex(null);
      setSyncConnected(false);
      return;
    }
    let stopped = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let indexVersion = "";
    const connect = () => {
      const url = new URL("/api/github/stars/sync/ws", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url);
      socket.onopen = () => {
        if (stopped) return;
        attempts = 0;
        setSyncConnected(true);
      };
      socket.onmessage = (event) => {
        if (stopped) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type !== "sync.status") return;
          const payload = message.data as GithubSyncStatus;
          setGithubSync(payload);
          const version = `${payload.repository_count}:${payload.chunk_count}:${payload.status}`;
          if (version !== indexVersion) {
            indexVersion = version;
            if (payload.repository_count > 0) void loadGithubIndex();
            else setGithubIndex(null);
          }
        } catch {
          if (import.meta.env.DEV)
            console.debug("[github-stars] Invalid sync event");
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setSyncConnected(false);
        // Reconnect transport only; status and index are never polled.
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 30000));
      };
      socket.onerror = () => socket.close();
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket.close();
    };
  }, [user?.id]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <div className="brand-mark">
            <Layers3 size={23} />
          </div>
          <div>
            <h1>
              Bottle <span>RAG</span>
            </h1>
            <p>Documents, answers, sources</p>
          </div>
        </a>
        <div className="sidebar-label">Workspace</div>
        <nav className="workspace-nav" aria-label="Workspace">
          <Button
            aria-current={workspace === "knowledge" ? "page" : undefined}
            variant={workspace === "knowledge" ? "secondary" : "ghost"}
            onClick={() => setWorkspace("knowledge")}
          >
            <BookOpen size={17} />
            Search documents
            <ChevronRight className="ml-auto" size={15} />
          </Button>
          <Button
            aria-current={workspace === "github" ? "page" : undefined}
            variant={workspace === "github" ? "secondary" : "ghost"}
            onClick={() => setWorkspace("github")}
          >
            <Github size={17} />
            GitHub import
            <ChevronRight className="ml-auto" size={15} />
          </Button>
        </nav>
        <Separator />
        <div className="panel-header">
          <div className="sidebar-label">
            Document library <span>{documents.length}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh documents"
            disabled={!user || status === "connecting" || status === "loading"}
            onClick={() => loadDocuments()}
          >
            <RefreshCw
              size={15}
              className={status === "connecting" ? "animate-spin" : ""}
            />
          </Button>
        </div>
        <div className="library-summary">
          <span>{documents.length} documents</span>
          <span>{chunkCount} passages</span>
        </div>
        <div className="document-list">
          {documents.length ? (
            documents.map((doc) => (
              <article className="document-item" key={doc.path}>
                <FileText size={17} />
                <div>
                  <div className="document-title">{doc.title}</div>
                  <div className="document-path" title={doc.path}>
                    {doc.chunk_count} passages
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="sidebar-empty">
              <FolderOpen size={28} />
              <p>
                {user
                  ? "Your library is empty"
                  : "Sign in to view your documents"}
              </p>
              <span>
                {user
                  ? "Your indexed documents will appear here."
                  : "Search your documents and find answers with sources."}
              </span>
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          <div className="privacy-note">
            <ShieldCheck size={15} />
            Indexed documents · Verifiable sources
          </div>
          {user ? (
            <div className="account-card">
              <div className="user-avatar">
                {user.image ? (
                  <img src={user.image} alt="" />
                ) : (
                  (user.name || user.email).slice(0, 1).toUpperCase()
                )}
              </div>
              <div className="min-w-0">
                <div className="document-title">
                  {user.name || "My account"}
                </div>
                <div className="account-email">{user.email}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                aria-label="Sign out"
              >
                <LogOut size={16} />
              </Button>
            </div>
          ) : (
            <Button
              className="w-full"
              onClick={() => openLogin()}
              disabled={sessionPending}
            >
              <LogIn size={16} />
              {sessionPending ? "Loading account…" : "Sign in / Create account"}
            </Button>
          )}
        </div>
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>
              {workspace === "knowledge" ? "Search documents" : "GitHub import"}
            </span>
          </div>
          <Badge variant="outline" className="connection-badge">
            <span
              className={`status-dot ${status === "error" ? "error" : ""}`}
            />
            {!user ? "Guest" : statusLabel(status)}
          </Badge>
        </header>
        <div className="workspace-content">
          <div className="page-heading">
            <div className="eyebrow">
              <Sparkles size={14} /> YOUR DOCUMENT WORKSPACE
            </div>
            <h2>
              {workspace === "knowledge"
                ? "Search documents. Find answers."
                : "Bring your Stars into Bottle."}
            </h2>
            <p>
              {workspace === "knowledge"
                ? "Bottle is a RAG application for searching documents and answering questions with sources."
                : "Import selected GitHub repositories, then search their content and explore the sources."}
            </p>
          </div>
          {workspace === "knowledge" ? (
            <>
              <Card className="query-panel">
                <CardContent className="p-0">
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitSearch();
                    }}
                  >
                    <Label htmlFor="queryInput" className="composer-label">
                      <MessageSquare size={17} />
                      Ask about your documents
                    </Label>
                    <Textarea
                      id="queryInput"
                      rows={4}
                      placeholder="Ask a question or enter keywords…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          (event.metaKey || event.ctrlKey) &&
                          event.key === "Enter" &&
                          status !== "loading"
                        ) {
                          event.preventDefault();
                          submitSearch();
                        }
                      }}
                    />
                    <div className="query-actions">
                      <div className="topk-control">
                        <Label htmlFor="topKInput">Source passages</Label>
                        <select
                          id="topKInput"
                          value={topK}
                          onChange={(event) =>
                            setTopK(Number(event.target.value))
                          }
                        >
                          {[3, 5, 10, 15, 20].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                        <span className="shortcut">⌘ / Ctrl + Enter</span>
                      </div>
                      <Button
                        type="submit"
                        disabled={
                          !query.trim() ||
                          status === "loading" ||
                          sessionPending
                        }
                      >
                        {status === "loading" ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ArrowUpRight />
                        )}
                        {status === "loading"
                          ? "Finding answers…"
                          : "Search and ask"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
              <div className="examples">
                <span>Try a question</span>
                {EXAMPLE_QUERIES.map((example) => (
                  <Button
                    variant="outline"
                    size="sm"
                    key={example}
                    disabled={status === "loading"}
                    onClick={() => {
                      setQuery(example);
                      if (user) submitSearch(example);
                      else openLogin();
                    }}
                  >
                    {example}
                    <ArrowUpRight size={13} />
                  </Button>
                ))}
              </div>
              {error && user ? (
                <div className="error-message" role="alert">
                  <CircleAlert size={17} />
                  {error}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => submitSearch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
              {status === "loading" ? (
                <Card className="loading-card" role="status">
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={18} />
                    Searching documents for relevant passages…
                  </div>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                  <Skeleton className="h-4 w-3/5" />
                </Card>
              ) : null}
              {result ? (
                <>
                  <section className="result-panel">
                    <div className="section-title">
                      <h3>Answer draft</h3>
                      <span>
                        {result.document_count} documents · {result.chunk_count}{" "}
                        passages
                      </span>
                    </div>
                    <div className="answer-output">
                      {result.answer
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .map((line) => (
                          <div className="answer-line" key={line}>
                            {line}
                          </div>
                        ))}
                    </div>
                  </section>

                  {result.sources.length > 0 ? (
                    <section className="sources-panel">
                      <div className="section-title">
                        <h3>Sources</h3>
                      </div>
                      <div className="sources-list">
                        {result.sources.map((source) => (
                          <article
                            className="source-item"
                            key={source.chunk_id}
                          >
                            <div className="source-meta">
                              <div className="source-title">
                                {source.section || source.chunk_id}
                              </div>
                              <span className="score">
                                {formatScore(source.score)}
                              </span>
                            </div>
                            <div className="document-path">{source.source}</div>
                          </article>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {result.hits.length > 0 ? (
                    <details className="hits-panel">
                      <summary>
                        View retrieved passages · {result.hits.length} passages
                      </summary>
                      <div className="hits-list">
                        {result.hits.map((hit, index) => (
                          <article
                            className="hit-item"
                            key={hit.chunk.chunk_id}
                          >
                            <div className="hit-meta">
                              <div className="hit-title">
                                #{index + 1} {hit.chunk.section}
                              </div>
                              <span className="score">
                                {formatScore(hit.score)}
                              </span>
                            </div>
                            <p className="hit-text">{hit.chunk.text}</p>
                          </article>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </>
              ) : null}

              {!result && status !== "loading" ? (
                <div className="welcome-state">
                  <div className="welcome-icon">
                    <MessagesSquare size={29} />
                  </div>
                  <h3>Start with a question</h3>
                  <p>
                    Search your documents with a question or keywords.
                    <br />
                    Explore an answer draft alongside the passages that support
                    it.
                  </p>
                  <div className="feature-row">
                    <span>
                      <Search size={15} />
                      Document search
                    </span>
                    <span>
                      <FileText size={15} />
                      Source citations
                    </span>
                    <span>
                      <ShieldCheck size={15} />
                      Your document library
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          ) : user ? (
            <>
              <section className="github-panel">
                <div className="section-title">
                  <h3>Import from GitHub Stars</h3>
                  <span>Import repository content to make it searchable</span>
                </div>
                <div className="github-sync-card">
                  <div>
                    <div className="document-title">GitHub import</div>
                    {!syncConnected && (
                      <div className="document-path" role="status">
                        Live updates disconnected. Reconnecting…
                      </div>
                    )}
                    <div className="document-path">
                      {githubSync
                        ? [
                            syncStatusLabel(githubSync.status),
                            `${githubSync.repository_count} repositories`,
                            `${githubSync.chunk_count} passages`,
                            formatEmbeddingSummary(githubSync),
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "Waiting for import status"}
                    </div>
                  </div>
                  <div className="github-sync-actions">
                    <Button
                      className="secondary-button"
                      type="button"
                      disabled={
                        syncBusy || isGithubSyncActive(githubSync?.status)
                      }
                      onClick={() => setRepositoryPickerOpen(true)}
                    >
                      Import GitHub Stars
                    </Button>
                    <Button
                      className="secondary-button"
                      type="button"
                      disabled={
                        syncBusy || !isGithubSyncActive(githubSync?.status)
                      }
                      onClick={() => runSyncAction(cancelGithubSync)}
                    >
                      Cancel
                    </Button>
                    <Button
                      className="secondary-button"
                      type="button"
                      disabled={
                        syncBusy || isGithubSyncActive(githubSync?.status)
                      }
                      onClick={() => runSyncAction(loadGithubIndex)}
                    >
                      View imported documents
                    </Button>
                    <Button
                      className="danger-button"
                      type="button"
                      disabled={
                        syncBusy || isGithubSyncActive(githubSync?.status)
                      }
                      onClick={() => setConfirmation({})}
                    >
                      Delete imported data
                    </Button>
                  </div>
                  {githubSync ? (
                    <>
                      <div
                        className="sync-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={githubSync.progress}
                        aria-label="GitHub import progress"
                      >
                        <div style={{ width: `${githubSync.progress}%` }} />
                      </div>
                      <div className="document-path">
                        {formatGithubSyncProgress(githubSync)}
                        {githubSync.error
                          ? ` · ${englishMessage(githubSync.error)}`
                          : ""}
                      </div>
                    </>
                  ) : null}
                </div>
                {githubIndex?.stars.length ? (
                  <div className="github-index-panel">
                    <div className="section-title">
                      <h3>Imported repositories</h3>
                      <span>
                        {githubIndex.total} repositories ·{" "}
                        {formatEmbeddingSummary(githubIndex)}
                      </span>
                    </div>
                    <div className="github-stars-list compact-list">
                      {githubIndex.stars.map((star) => (
                        <article className="github-star-item" key={star.repoId}>
                          <div className="github-star-header with-action">
                            {star.owner.avatarUrl ? (
                              <img
                                className="github-owner-avatar"
                                src={star.owner.avatarUrl}
                                alt=""
                              />
                            ) : null}
                            <div>
                              <a
                                className="github-star-title"
                                href={star.htmlUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {star.fullName}
                              </a>
                              <div className="document-path">
                                {formatSyncedGithubMeta(star)}
                              </div>
                            </div>
                            <Button
                              className="danger-button compact-button"
                              type="button"
                              disabled={
                                syncBusy ||
                                isGithubSyncActive(githubSync?.status)
                              }
                              onClick={() =>
                                setConfirmation({ repoId: star.repoId })
                              }
                            >
                              Delete
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="github-search">
                  <Input
                    type="search"
                    aria-label="Search imported GitHub documents"
                    placeholder="Search repository content… Try language:python or topic:rag"
                    value={githubQuery}
                    onChange={(event) => setGithubQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        searchGithubStars();
                      }
                    }}
                  />
                  <Button
                    className="secondary-button"
                    type="button"
                    disabled={githubStatus === "loading" || !githubQuery.trim()}
                    onClick={searchGithubStars}
                  >
                    {githubStatus === "loading"
                      ? "Searching"
                      : "Search documents"}
                  </Button>
                </div>
                {githubError ? (
                  <div className="error-message compact">{githubError}</div>
                ) : null}
                {githubResult ? (
                  <div className="github-rag-answer">
                    <div className="document-path">
                      {[
                        `Matching repositories ${githubResult.filtered_repository_count} / ${githubResult.repository_count}`,
                        `Passages ${githubResult.chunk_count}`,
                        formatEmbeddingSummary(githubResult),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                    {githubResult.answer
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .map((line) => (
                        <div className="answer-line" key={line}>
                          {line}
                        </div>
                      ))}
                  </div>
                ) : null}
                {githubStatus === "loading" ? (
                  <div className="loading-card" role="status">
                    <Loader2 className="animate-spin" size={18} />
                    Searching imported repository documents…
                  </div>
                ) : null}
                {githubResult && !githubResult.stars.length ? (
                  <div className="welcome-state">
                    <Search size={28} />
                    <h3>No matching documents</h3>
                    <p>
                      Try different keywords or import more repositories from
                      GitHub Stars.
                    </p>
                  </div>
                ) : null}
                {githubResult?.stars.length ? (
                  <div className="github-stars-list">
                    {githubResult.stars.map((star, index) => {
                      const source = githubResult.sources[index];
                      return (
                        <article className="github-star-item" key={star.id}>
                          <div className="github-star-header">
                            {star.owner.avatarUrl ? (
                              <img
                                className="github-owner-avatar"
                                src={star.owner.avatarUrl}
                                alt=""
                              />
                            ) : null}
                            <div>
                              <a
                                className="github-star-title"
                                href={star.htmlUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {star.fullName}
                              </a>
                              <div className="document-path">
                                {formatGithubMeta(star)} ·{" "}
                                {formatScore(source?.score || 0)}
                              </div>
                            </div>
                          </div>
                          {star.description ? (
                            <p className="github-star-description">
                              {star.description}
                            </p>
                          ) : null}
                          {star.topics.length > 0 ? (
                            <div className="github-topics">
                              {star.topics.slice(0, 6).map((topic) => (
                                <span key={topic}>{topic}</span>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            </>
          ) : (
            <Card className="welcome-state">
              <Github size={36} />
              <h3>Add GitHub content to your library</h3>
              <p>
                Sign in with GitHub to choose starred repositories and import
                their descriptions and READMEs.
              </p>
              <Button onClick={() => openLogin()}>
                <LogIn size={16} />
                Sign in to import
              </Button>
            </Card>
          )}
        </div>
        <footer className="workspace-footer">
          Bottle · Search documents. Answer with sources.
          <span>Review the cited sources to verify each answer.</span>
        </footer>
      </section>
      <GithubRepositoryPicker
        open={repositoryPickerOpen && !!user}
        onOpenChange={setRepositoryPickerOpen}
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
              This permanently deletes the selected repository data and indexed
              passages from Bottle. You can import the content again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncBusy}>Keep data</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={syncBusy}
              onClick={async () => {
                if (!confirmation) return;
                setSyncBusy(true);
                try {
                  if (confirmation.repoId)
                    await resetGithubRepository(confirmation.repoId);
                  else await resetGithubSync();
                  setConfirmation(null);
                } finally {
                  setSyncBusy(false);
                }
              }}
            >
              {syncBusy ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function getErrorMessage(error: unknown) {
  return englishMessage(error instanceof Error ? error.message : null);
}

function statusClassName(status: "connecting" | "ok" | "loading" | "error") {
  if (status === "ok") {
    return "ok";
  }
  if (status === "error") {
    return "error";
  }
  return "";
}

function statusLabel(status: "connecting" | "ok" | "loading" | "error") {
  const labels = {
    connecting: "Connecting",
    ok: "Ready",
    loading: "Searching",
    error: "Unavailable",
  };
  return labels[status];
}

function formatScore(score: number) {
  return `score ${score.toFixed(3)}`;
}

function formatGithubMeta(star: GithubStar) {
  const updatedAt = star.updatedAt ? new Date(star.updatedAt) : null;
  const updatedLabel =
    updatedAt && !Number.isNaN(updatedAt.getTime())
      ? `updated ${updatedAt.toLocaleDateString("en-US")}`
      : "";
  const parts = [
    star.language,
    `★ ${star.stargazersCount.toLocaleString("en-US")}`,
    updatedLabel,
  ].filter(Boolean);

  return parts.join(" · ");
}

function formatSyncedGithubMeta(star: SyncedGithubStar) {
  const syncedAt = star.syncedAt ? new Date(star.syncedAt * 1000) : null;
  const syncedLabel =
    syncedAt && !Number.isNaN(syncedAt.getTime())
      ? `synced ${syncedAt.toLocaleString("en-US")}`
      : "";
  const parts = [
    formatGithubMeta(star),
    `${star.chunkCount} passages`,
    star.readmeLength > 0
      ? `README ${star.readmeLength.toLocaleString("en-US")} characters`
      : "",
    syncedLabel,
  ].filter(Boolean);

  return parts.join(" · ");
}

function formatEmbeddingSummary(payload: {
  embedding_provider?: string;
  embedding_model?: string;
}) {
  const parts = [payload.embedding_provider, payload.embedding_model].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(" / ") : "";
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
