import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fetchJson } from "@/lib/api";

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
};
type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  onSync: (ids: number[]) => Promise<void>;
  busy: boolean;
};

export function GithubRepositoryPicker({
  open,
  onOpenChange,
  userId,
  onSync,
  busy,
}: Props) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [nextPage, setNextPage] = useState(1);
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
      const result = await fetchJson<AvailableRepositories>(
        `/api/github/stars/available?page=${page}`,
        { signal: request.signal },
      );
      if (generation.current !== requestGeneration) return;
      setRepositories((previous) => [
        ...new Map(
          (reset ? result.stars : [...previous, ...result.stars]).map(
            (repo) => [repo.id, repo],
          ),
        ).values(),
      ]);
      if (reset) setSelected(new Set(result.selected_repository_ids));
      setNextPage(result.page + 1);
      setHasMore(result.has_more);
      setTruncated(result.truncated);
    } catch (error) {
      if (generation.current === requestGeneration && !request.signal.aborted) {
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
    if (!open) return;
    setRepositories([]);
    setSelected(new Set());
    setFilter("");
    setLoadError("");
    setSubmitError("");
    setHasMore(false);
    setTruncated(false);
    setNextPage(1);
    loadPage(1, true);
    return () => {
      generation.current++;
      controller.current?.abort();
      controller.current = null;
    };
  }, [open, userId]);

  const term = filter.trim().toLocaleLowerCase();
  const visible = repositories.filter((repo) =>
    [repo.fullName, repo.description, repo.language]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(term),
  );
  const allVisibleSelected =
    visible.length > 0 && visible.every((repo) => selected.has(repo.id));
  const loadedIds = new Set(repositories.map((repo) => repo.id));
  const unloadedSelection = [...selected].filter(
    (id) => !loadedIds.has(id),
  ).length;

  function toggle(id: number, checked: boolean) {
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
      await onSync([...selected].sort((a, b) => a - b));
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Unable to start the import. Please try again.",
      );
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Import from GitHub Stars</DialogTitle>
          <DialogDescription>
            Import descriptions and READMEs from selected repositories. Future
            refreshes use this selection. Other imported documents are kept.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            size={15}
          />
          <Input
            className="pl-9"
            aria-label="Filter loaded repositories"
            placeholder="Filter loaded repositories by name, description, or language…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {repositories.length} loaded · {selected.size} selected
            {unloadedSelection > 0
              ? ` (${unloadedSelection} not loaded yet)`
              : ""}
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !visible.length}
              onClick={() =>
                setSelected((previous) => {
                  const next = new Set(previous);
                  visible.forEach((repo) => {
                    if (allVisibleSelected) next.delete(repo.id);
                    else next.add(repo.id);
                  });
                  return next;
                })
              }
            >
              {allVisibleSelected ? "Deselect results" : "Select results"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !selected.size}
              onClick={() => setSelected(new Set())}
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
                checked={selected.has(repo.id)}
                onCheckedChange={(checked) => toggle(repo.id, checked)}
                disabled={busy}
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
                ? "No matches. Change your search or load more repositories."
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
              onClick={() => loadPage(nextPage, nextPage === 1)}
            >
              Retry
            </Button>
          </div>
        ) : null}
        {hasMore && !loadError ? (
          <Button
            variant="outline"
            disabled={loading || busy}
            onClick={() => loadPage(nextPage)}
          >
            {loading ? "Loading…" : "Load more repositories"}
          </Button>
        ) : null}
        {truncated ? (
          <p className="text-xs text-muted-foreground">
            The repository list limit has been reached. Ask your administrator
            to increase it to see more repositories.
          </p>
        ) : null}
        {submitError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitError}
          </p>
        ) : null}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t pt-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={busy || loading || !selected.size} onClick={submit}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {busy ? "Starting import…" : `Import ${selected.size} selected`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
