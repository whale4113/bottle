import { useEffect, useState } from "react";
import { fetchJson } from "./api";

export type GithubSyncStatus = {
  status: "idle" | "queued" | "downloading_model" | "running" | "completed" | "failed" | "canceled";
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

export function useGithubSync(userId: string | undefined) {
  const [githubSync, setGithubSync] = useState<GithubSyncStatus | null>(null);
  const [syncAvailable, setSyncAvailable] = useState(true);

  useEffect(() => {
    setGithubSync(null);
    setSyncAvailable(true);
    if (!userId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    async function poll() {
      let delay = 15000;
      try {
        const status = await fetchJson<GithubSyncStatus>("/api/github/stars/sync", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted) return;
        setGithubSync(status);
        setSyncAvailable(true);
        failures = 0;
        if (["queued", "downloading_model", "running"].includes(status.status)) delay = 2000;
      } catch {
        if (controller.signal.aborted) return;
        setSyncAvailable(false);
        delay = Math.min(2000 * 2 ** failures++, 30000);
      }
      // Schedule after completion so slow requests never overlap.
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [userId]);

  return { githubSync, setGithubSync, syncAvailable };
}
