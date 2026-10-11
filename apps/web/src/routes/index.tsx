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
  "为什么生产级 RAG 需要混合搜索？",
  "重排序 RAG 解决什么问题？",
  "什么时候需要 SQL + Vector RAG？",
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
      if (response.error) throw new Error(response.error.message || "退出失败");
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
      setGithubError("请先登录后再搜索 GitHub Stars");
      return;
    }
    if (!githubQuery.trim()) {
      setGithubError("请输入要检索的 GitHub Stars 问题或关键词");
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
      throw new Error("同步任务进行中，请稍后重试");
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
              知屿 <span>Knowledge</span>
            </h1>
            <p>连接知识，发现答案</p>
          </div>
        </a>
        <div className="sidebar-label">工作空间</div>
        <nav className="workspace-nav" aria-label="工作空间">
          <Button
            aria-current={workspace === "knowledge" ? "page" : undefined}
            variant={workspace === "knowledge" ? "secondary" : "ghost"}
            onClick={() => setWorkspace("knowledge")}
          >
            <BookOpen size={17} />
            知识库问答
            <ChevronRight className="ml-auto" size={15} />
          </Button>
          <Button
            aria-current={workspace === "github" ? "page" : undefined}
            variant={workspace === "github" ? "secondary" : "ghost"}
            onClick={() => setWorkspace("github")}
          >
            <Github size={17} />
            GitHub Stars
            <ChevronRight className="ml-auto" size={15} />
          </Button>
        </nav>
        <Separator />
        <div className="panel-header">
          <div className="sidebar-label">
            我的知识库 <span>{documents.length}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新知识库"
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
          <span>{documents.length} 篇文档</span>
          <span>{chunkCount} 个片段</span>
        </div>
        <div className="document-list">
          {documents.length ? (
            documents.map((doc) => (
              <article className="document-item" key={doc.path}>
                <FileText size={17} />
                <div>
                  <div className="document-title">{doc.title}</div>
                  <div className="document-path" title={doc.path}>
                    {doc.chunk_count} 个片段
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="sidebar-empty">
              <FolderOpen size={28} />
              <p>{user ? "知识库还没有文档" : "登录后查看你的文档"}</p>
              <span>
                {user
                  ? "将 Markdown 文档放入 materials 目录后刷新"
                  : "你的知识，随时可查"}
              </span>
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          <div className="privacy-note">
            <ShieldCheck size={15} />
            本地索引 · 专注你的知识
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
                <div className="document-title">{user.name || "我的账户"}</div>
                <div className="account-email">{user.email}</div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                aria-label="退出登录"
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
              {sessionPending ? "正在加载账户…" : "登录 / 创建账户"}
            </Button>
          )}
        </div>
      </aside>
      <section className="workspace">
        <header className="workspace-header">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={14} />
            <span>
              {workspace === "knowledge" ? "知识库问答" : "GitHub Stars"}
            </span>
          </div>
          <Badge variant="outline" className="connection-badge">
            <span
              className={`status-dot ${status === "error" ? "error" : ""}`}
            />
            {!user ? "访客模式" : statusLabel(status)}
          </Badge>
        </header>
        <div className="workspace-content">
          <div className="page-heading">
            <div className="eyebrow">
              <Sparkles size={14} /> YOUR PERSONAL KNOWLEDGE SPACE
            </div>
            <h2>
              {workspace === "knowledge"
                ? "让知识，成为你的答案。"
                : "收藏不止于收藏。"}
            </h2>
            <p>
              {workspace === "knowledge"
                ? "从你的文档中寻找灵感，每一个答案都有据可循。"
                : "同步你的 GitHub Stars，用自然语言找到下一件趁手的工具。"}
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
                      向知识库提问
                    </Label>
                    <Textarea
                      id="queryInput"
                      rows={4}
                      placeholder="你想了解什么？试着描述你的问题…"
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
                        <Label htmlFor="topKInput">引用片段</Label>
                        <select
                          id="topKInput"
                          value={topK}
                          onChange={(event) =>
                            setTopK(Number(event.target.value))
                          }
                        >
                          {[3, 5, 10, 15, 20].map((n) => (
                            <option key={n} value={n}>
                              {n} 条
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
                        {status === "loading" ? "正在查找答案…" : "开始提问"}
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
              <div className="examples">
                <span>试着问问</span>
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
                    重试
                  </Button>
                </div>
              ) : null}
              {status === "loading" ? (
                <Card className="loading-card" role="status">
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={18} />
                    正在阅读文档，整理相关信息…
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
                      <h3>答案草稿</h3>
                      <span>
                        {result.document_count} 个文档 · {result.chunk_count}{" "}
                        个分块
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
                        <h3>引用来源</h3>
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
                        查看检索明细 · {result.hits.length} 个片段
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
                  <h3>好问题，是发现的开始</h3>
                  <p>
                    输入问题或选择上方示例。我们会为你整理答案，
                    <br />
                    并附上相关文档和引用片段。
                  </p>
                  <div className="feature-row">
                    <span>
                      <Search size={15} />
                      智能检索
                    </span>
                    <span>
                      <FileText size={15} />
                      来源可追溯
                    </span>
                    <span>
                      <ShieldCheck size={15} />
                      本地知识库
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          ) : user ? (
            <>
              <section className="github-panel">
                <div className="section-title">
                  <h3>GitHub Stars RAG</h3>
                  <span>同步入库后检索本地索引</span>
                </div>
                <div className="github-sync-card">
                  <div>
                    <div className="document-title">Stars 索引</div>
                    {!syncConnected && (
                      <div className="document-path" role="status">
                        实时连接中断，正在重新连接…
                      </div>
                    )}
                    <div className="document-path">
                      {githubSync
                        ? [
                            syncStatusLabel(githubSync.status),
                            `${githubSync.repository_count} 个仓库`,
                            `${githubSync.chunk_count} 个分块`,
                            formatEmbeddingSummary(githubSync),
                          ]
                            .filter(Boolean)
                            .join(" · ")
                        : "尚未读取同步状态"}
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
                      选择仓库同步
                    </Button>
                    <Button
                      className="secondary-button"
                      type="button"
                      disabled={
                        syncBusy || !isGithubSyncActive(githubSync?.status)
                      }
                      onClick={() => runSyncAction(cancelGithubSync)}
                    >
                      取消
                    </Button>
                    <Button
                      className="secondary-button"
                      type="button"
                      disabled={
                        syncBusy || isGithubSyncActive(githubSync?.status)
                      }
                      onClick={() => runSyncAction(loadGithubIndex)}
                    >
                      查看数据
                    </Button>
                    <Button
                      className="danger-button"
                      type="button"
                      disabled={
                        syncBusy || isGithubSyncActive(githubSync?.status)
                      }
                      onClick={() => setConfirmation({})}
                    >
                      重置同步
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
                        aria-label="GitHub Stars 同步进度"
                      >
                        <div style={{ width: `${githubSync.progress}%` }} />
                      </div>
                      <div className="document-path">
                        {formatGithubSyncProgress(githubSync)}
                        {githubSync.error ? ` · ${githubSync.error}` : ""}
                      </div>
                    </>
                  ) : null}
                </div>
                {githubIndex?.stars.length ? (
                  <div className="github-index-panel">
                    <div className="section-title">
                      <h3>已同步数据</h3>
                      <span>
                        {githubIndex.total} 个仓库 ·{" "}
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
                              重置
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
                    aria-label="搜索 GitHub Stars"
                    placeholder="搜索本地 Stars 索引，支持 language:python topic:rag owner:xxx"
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
                    {githubStatus === "loading" ? "检索中" : "检索 Stars 索引"}
                  </Button>
                </div>
                {githubError ? (
                  <div className="error-message compact">{githubError}</div>
                ) : null}
                {githubResult ? (
                  <div className="github-rag-answer">
                    <div className="document-path">
                      {[
                        `候选仓库 ${githubResult.filtered_repository_count} / ${githubResult.repository_count}`,
                        `分块 ${githubResult.chunk_count}`,
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
                    正在检索你的收藏…
                  </div>
                ) : null}
                {githubResult && !githubResult.stars.length ? (
                  <div className="welcome-state">
                    <Search size={28} />
                    <h3>没有找到相关仓库</h3>
                    <p>试试其他关键词，或先同步最新的 Stars。</p>
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
              <h3>找回你收藏的好工具</h3>
              <p>登录 GitHub 后同步 Stars，建立专属的仓库知识库。</p>
              <Button onClick={() => openLogin()}>
                <LogIn size={16} />
                登录后开始
              </Button>
            </Card>
          )}
        </div>
        <footer className="workspace-footer">
          知屿 · 让每一份知识，都有回响
          <span>答案基于检索内容生成，请结合来源判断</span>
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
              确认重置{confirmation?.repoId ? "这个仓库" : "全部同步数据"}？
            </AlertDialogTitle>
            <AlertDialogDescription>
              相关仓库数据与检索片段将被删除。之后可以重新同步，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={syncBusy}>保留数据</AlertDialogCancel>
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
              {syncBusy ? "正在重置…" : "确认重置"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
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
    connecting: "连接中",
    ok: "已连接",
    loading: "检索中",
    error: "异常",
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
      ? `updated ${updatedAt.toLocaleDateString()}`
      : "";
  const parts = [
    star.language,
    `★ ${star.stargazersCount.toLocaleString()}`,
    updatedLabel,
  ].filter(Boolean);

  return parts.join(" · ");
}

function formatSyncedGithubMeta(star: SyncedGithubStar) {
  const syncedAt = star.syncedAt ? new Date(star.syncedAt * 1000) : null;
  const syncedLabel =
    syncedAt && !Number.isNaN(syncedAt.getTime())
      ? `synced ${syncedAt.toLocaleString()}`
      : "";
  const parts = [
    formatGithubMeta(star),
    `${star.chunkCount} 个分块`,
    star.readmeLength > 0
      ? `README ${star.readmeLength.toLocaleString()} 字符`
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
    return `${sync.message} · 已索引 ${sync.indexed}`;
  }
  const indexingProgress =
    sync.total > 0
      ? `${sync.processed}/${sync.total}`
      : sync.processed > 0
        ? `已拉取 ${sync.processed} 个`
        : "等待仓库列表";
  return `${sync.message} · ${indexingProgress} · 已索引 ${sync.indexed}`;
}

function syncStatusLabel(status: GithubSyncStatus["status"]) {
  const labels = {
    idle: "未同步",
    queued: "排队中",
    downloading_model: "下载模型中",
    running: "同步中",
    completed: "已同步",
    failed: "同步失败",
    canceled: "已取消",
  };
  return labels[status];
}
