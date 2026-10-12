import { useGithubSync, type GithubSyncStatus } from "@/lib/use-github-sync";
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
  BookOpen,
  FileText,
  GitFork,
  Globe,
  Star,
  Clock3,
  Layers3,
  Loader2,
  LogOut,
  Search,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchJson, streamAnswer } from "@/lib/api";
import { englishMessage } from "@/lib/messages";
import { authClient } from "@/lib/auth-client";

const MarkdownAnswer = lazy(() => import("@/components/markdown-answer"));

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
  forksCount?: number;
  updatedAt: string;
  topics: string[];
  owner: {
    login: string;
    avatarUrl: string;
  };
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

type ResultDocument = {
  id: string;
  source: string;
  title: string;
  kind: "Document" | "GitHub";
  url?: string;
  passages: string[];
  repository?: GithubStar;
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
  const { githubSync } = useGithubSync(user?.id);
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
      }).then((result) => {
        if (!request.signal.aborted) setResult(result);
        return result;
      }),
      fetchJson<GithubStarsRagResult>(
        `/api/github/stars?${new URLSearchParams({ query: value, limit: "10" })}`,
        { signal: request.signal },
      ).then((result) => {
        if (!request.signal.aborted) setGithubResult(result);
        return result;
      }),
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

  async function logout() {
    try {
      const response = await authClient.signOut();
      if (response.error)
        throw new Error(response.error.message || "Unable to sign out.");
      searchRequest.current?.abort();
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
              <Button
                variant="ghost"
                onClick={() => void navigate({ to: "/library" })}
              >
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
          {loading && !results.length ? (
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
                      <h2 className="bottle-result-title">
                        {item.kind === "GitHub" ? (
                          <img
                            className="bottle-repository-avatar"
                            src={safeWebUrl(item.repository?.owner.avatarUrl || "") || "https://github.githubassets.com/favicons/favicon.svg"}
                            alt={item.repository ? `${item.repository.owner.login} avatar` : "GitHub"}
                            width={20}
                            height={20}
                            loading="lazy"
                            onError={(event) => {
                              event.currentTarget.onerror = null;
                              event.currentTarget.src = "https://github.githubassets.com/favicons/favicon.svg";
                            }}
                          />
                        ) : item.url ? (
                          <Globe size={20} aria-label="Web document" />
                        ) : (
                          <FileText size={20} aria-label="Document" />
                        )}
                        {item.url ? (
                          <a href={item.url} target="_blank" rel="noreferrer">
                            {item.repository ? (
                              <>
                                {item.repository.owner.login} /{" "}
                                <strong>{item.repository.name}</strong>
                              </>
                            ) : (
                              item.title
                            )}
                          </a>
                        ) : (
                          item.title
                        )}
                      </h2>
                      <p className="bottle-result-excerpt">
                        {item.repository?.description || item.passages[0]}
                      </p>
                      {item.repository ? (
                        <RepositoryMetadata repository={item.repository} />
                      ) : (
                        <div className="bottle-result-metadata">
                          <span>{item.kind}</span>
                          <span className="bottle-result-location">
                            {item.source}
                          </span>
                        </div>
                      )}
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
    </main>
  );
}

const languageColors: Record<string, string> = {
  Rust: "#dea584",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572a5",
  Go: "#00add8",
  Java: "#b07219",
  Ruby: "#701516",
  Swift: "#f05138",
  CSS: "#563d7c",
  HTML: "#e34c26",
  "C++": "#f34b7d",
  C: "#555555",
};

function RepositoryMetadata({ repository }: { repository: GithubStar }) {
  const updated = new Date(repository.updatedAt);
  const validDate = !Number.isNaN(updated.getTime());
  return (
    <div className="bottle-result-metadata">
      {repository.language && (
        <span>
          <span
            className="bottle-language-dot"
            style={{
              backgroundColor: languageColors[repository.language] || "#8b949e",
            }}
          />
          {repository.language}
        </span>
      )}
      <span
        aria-label={`${repository.stargazersCount.toLocaleString("en-US")} stars`}
      >
        <Star size={16} />
        {repository.stargazersCount.toLocaleString("en-US")}
      </span>
      {repository.forksCount !== undefined && (
        <span
          aria-label={`${repository.forksCount.toLocaleString("en-US")} forks`}
        >
          <GitFork size={16} />
          {repository.forksCount.toLocaleString("en-US")}
        </span>
      )}
      {validDate && (
        <span>
          <Clock3 size={15} />
          <time
            dateTime={updated.toISOString()}
            title={updated.toLocaleString("en-US")}
          >
            Updated{" "}
            {updated.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
          </time>
        </span>
      )}
    </div>
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
    const repository = github?.stars.find(
      (star) =>
        safeWebUrl(star.htmlUrl) === safeWebUrl(hit.chunk.source) &&
        !!safeWebUrl(star.htmlUrl),
    );
    const key = `github:${hit.chunk.source}`;
    const previous = results.get(key);
    if (previous) previous.passages.push(hit.evidence || hit.chunk.text);
    else
      results.set(key, {
        id: `source-${results.size + 1}`,
        source: hit.chunk.source,
        title: repository?.fullName || hit.chunk.section || hit.chunk.source,
        repository,
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
