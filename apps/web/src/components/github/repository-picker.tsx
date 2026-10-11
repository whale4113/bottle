import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { fetchJson } from "@/lib/api";

const PAGE_SIZE = 10;
const API_PAGE_SIZE = 100;

type Repository = {
  id: number;
  fullName: string;
  description: string | null;
  language: string | null;
  stargazersCount: number;
  synced: boolean;
};
type AvailableRepositories = {
  stars: Repository[];
  page: number;
  has_more: boolean;
  truncated: boolean;
  selected_repository_ids: number[];
  total_star_count: number;
};
export type RepositorySelection =
  | { repositoryIds: number[] }
  | { selectAll: true; excludedRepositoryIds: number[] };

type Props = {
  onCancel: () => void;
  userId: string;
  onSync: (selection: RepositorySelection) => Promise<void>;
  busy: boolean;
};

export function GithubRepositoryPicker({
  onCancel,
  userId,
  onSync,
  busy,
}: Props) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [allSelected, setAllSelected] = useState(false);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [currentPage, setCurrentPage] = useState(0);
  const [failedPage, setFailedPage] = useState(1);
  const [lastPage, setLastPage] = useState<number | null>(null);
  const pages = useRef(new Map<number, AvailableRepositories>());
  const [hasMore, setHasMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  async function loadPage(page: number, reset = false) {
    if (controller.current) return;
    const requestGeneration = generation.current;
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setLoadError("");
    try {
      const apiPage = Math.floor(((page - 1) * PAGE_SIZE) / API_PAGE_SIZE) + 1;
      const result =
        pages.current.get(apiPage) ||
        (await fetchJson<AvailableRepositories>(
          `/api/github/stars/available?page=${apiPage}`,
          { signal: request.signal },
        ));
      if (generation.current !== requestGeneration) return;
      pages.current.set(apiPage, result);
      const offset = ((page - 1) * PAGE_SIZE) % API_PAGE_SIZE;
      setRepositories(result.stars.slice(offset, offset + PAGE_SIZE));
      if (reset) setSelected(new Set(result.selected_repository_ids));
      setTotalCount(result.total_star_count);
      setLastPage(Math.max(1, Math.ceil(result.total_star_count / PAGE_SIZE)));
      setCurrentPage(page);
      setFilter("");
      setHasMore(offset + PAGE_SIZE < result.stars.length || result.has_more);
      setTruncated(result.truncated);
    } catch (error) {
      if (generation.current === requestGeneration && !request.signal.aborted) {
        setFailedPage(page);
        setLoadError(
          error instanceof Error
            ? error.message
            : "Unable to load repositories. Please try again.",
        );
      }
    } finally {
      if (generation.current === requestGeneration) {
        controller.current = null;
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    generation.current++;
    setRepositories([]);
    setSelected(new Set());
    setFilter("");
    setLoadError("");
    setSubmitError("");
    setAllSelected(false);
    setExcluded(new Set());
    setTotalCount(null);
    setHasMore(false);
    setTruncated(false);
    setCurrentPage(0);
    setLastPage(null);
    pages.current.clear();
    loadPage(1, true);
    return () => {
      generation.current++;
      controller.current?.abort();
      controller.current = null;
    };
  }, [userId]);

  const term = filter.trim().toLocaleLowerCase();
  const visible = repositories.filter((repo) =>
    [repo.fullName, repo.description, repo.language]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(term),
  );
  const allVisibleSelected =
    visible.length > 0 &&
    visible.every((repo) =>
      allSelected ? !excluded.has(repo.id) : selected.has(repo.id),
    );
  const currentIds = new Set(repositories.map((repo) => repo.id));
  const selectedCount = allSelected
    ? Math.max(0, (totalCount || 0) - excluded.size)
    : selected.size;
  const otherPageSelection = Math.max(
    0,
    selectedCount -
      repositories.filter((repo) =>
        allSelected ? !excluded.has(repo.id) : selected.has(repo.id),
      ).length,
  );

  function toggle(id: number, checked: boolean) {
    if (allSelected) {
      setExcluded((previous) => {
        const next = new Set(previous);
        if (checked) next.delete(id);
        else next.add(id);
        return next;
      });
      return;
    }
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setSubmitError("");
  }

  async function submit() {
    setSubmitError("");
    try {
      await onSync(
        allSelected
          ? { selectAll: true, excludedRepositoryIds: [...excluded] }
          : { repositoryIds: [...selected].sort((a, b) => a - b) },
      );
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Unable to start the import. Please try again.",
      );
    }
  }

  const content = (
    <>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          size={15}
        />
        <Input
          className="pl-9"
          aria-label="Filter this page"
          placeholder="Filter this page by name, description, or language…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          disabled={busy || loading}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {totalCount?.toLocaleString() ?? "…"} starred ·{" "}
          {selectedCount.toLocaleString()} selected
          {otherPageSelection > 0
            ? ` (${otherPageSelection} on other pages)`
            : ""}
        </span>
        <div className="flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || loading || !totalCount}
            onClick={() => {
              setAllSelected(true);
              setExcluded(new Set());
              setSubmitError("");
            }}
          >
            Select all repositories
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || loading || !visible.length}
            onClick={() => {
              if (allSelected)
                setExcluded((previous) => {
                  const next = new Set(previous);
                  visible.forEach((repo) => {
                    if (allVisibleSelected) next.add(repo.id);
                    else next.delete(repo.id);
                  });
                  return next;
                });
              else
                setSelected((previous) => {
                  const next = new Set(previous);
                  visible.forEach((repo) => {
                    if (allVisibleSelected) next.delete(repo.id);
                    else next.add(repo.id);
                  });
                  return next;
                });
            }}
          >
            {allVisibleSelected ? "Deselect this page" : "Select this page"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || loading || !selectedCount}
            onClick={() => {
              setAllSelected(false);
              setExcluded(new Set());
              setSelected(new Set());
            }}
          >
            Clear selection
          </Button>
        </div>
      </div>
      <div
        className="min-h-0 overflow-y-auto rounded-lg border"
        aria-label="Available repositories"
        aria-busy={loading}
      >
        {visible.map((repo) => (
          <label
            key={repo.id}
            className="flex cursor-pointer items-start gap-3 border-b p-3 last:border-0 hover:bg-muted/50"
          >
            <Checkbox
              className="mt-1"
              checked={
                allSelected ? !excluded.has(repo.id) : selected.has(repo.id)
              }
              onCheckedChange={(checked) => toggle(repo.id, checked)}
              disabled={busy || loading}
              aria-label={`Select ${repo.fullName}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-all text-sm font-medium">
                  {repo.fullName}
                </span>
                {repo.synced ? (
                  <Badge variant="secondary">
                    <Check size={12} />
                    Imported
                  </Badge>
                ) : null}
              </div>
              {repo.description ? (
                <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
                  {repo.description}
                </p>
              ) : null}
              <div className="mt-2 text-xs text-muted-foreground">
                {[repo.language, `★ ${repo.stargazersCount.toLocaleString()}`]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            </div>
          </label>
        ))}
        {!loading && !loadError && !visible.length ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {repositories.length
              ? "No matches on this page. Change your filter or try another page."
              : "No starred repositories yet. Star a repository on GitHub to import it here."}
          </div>
        ) : null}
        {loading ? (
          <div
            className="flex items-center justify-center gap-2 p-5 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 size={16} className="animate-spin" />
            Loading repositories…
          </div>
        ) : null}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Select all includes every starred repository without loading other
        pages. Repositories already indexed with your current embedding model
        are skipped during import.
      </p>
      {loadError ? (
        <div
          className="flex items-center justify-between gap-2 text-sm text-destructive"
          role="alert"
        >
          {loadError}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || loading}
            onClick={() => loadPage(failedPage, currentPage === 0)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      <nav
        className="flex flex-wrap items-center justify-between gap-2"
        aria-label="Repository pagination"
      >
        <Button
          variant="outline"
          size="sm"
          disabled={loading || busy || currentPage <= 1}
          onClick={() => loadPage(currentPage - 1)}
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          Page {currentPage || 1}
          {lastPage !== null ? ` of ${lastPage}` : ""} · {PAGE_SIZE} per page
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={loading || busy || !hasMore || !currentPage}
          onClick={() => loadPage(currentPage + 1)}
        >
          Next
        </Button>
      </nav>
      {truncated ? (
        <p className="text-xs text-muted-foreground">
          The repository list limit has been reached. Ask your administrator to
          increase it to see more repositories.
        </p>
      ) : null}
      {submitError ? (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      ) : null}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t pt-3">
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || loading || !selectedCount} onClick={submit}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {busy
            ? "Starting import…"
            : `Import ${selectedCount.toLocaleString()} selected`}
        </Button>
      </div>
    </>
  );
  return (
    <section
      className="grid min-w-0 gap-4 rounded-2xl border bg-card p-5 sm:p-7"
      aria-label="Import from GitHub Stars"
    >
      {content}
    </section>
  );
}
