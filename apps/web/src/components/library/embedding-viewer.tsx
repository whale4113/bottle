import { useEffect, useState } from "react";
import { fetchJson } from "@/lib/api";
import { Button } from "@/components/ui/button";

type Page = { total: number; limit: number; chunks: { chunk_id: string; source_text: string; embedding_input: string | null; vector: number[] | Record<string, number>; dimensions: number; provider: string; model: string }[] };
export function EmbeddingViewer({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setError("");
    void fetchJson<Page>(`${url}${url.includes("?") ? "&" : "?"}offset=${offset}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setPage(value); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [url, offset]);
  return <section className="grid gap-4 rounded-xl border bg-card p-5" aria-label="Embedding details">
    <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">Embeddings · {title}</h3><Button variant="ghost" onClick={onClose}>Close</Button></div>
    {error ? <p role="alert">{error}</p> : !page ? <p role="status">Loading embeddings…</p> : <>
      <p className="text-sm text-muted-foreground">{page.total} stored vectors. Local document vectors appear after a search and remain available until the API restarts or its cache expires.</p>
      {page.chunks.map((chunk) => <article key={chunk.chunk_id} className="grid min-w-0 gap-2 rounded-lg border p-4">
        <h4 className="break-all font-medium">{chunk.chunk_id}</h4>
        <p className="text-xs text-muted-foreground">{chunk.provider} · {chunk.model} · {chunk.dimensions} dimensions</p>
        <strong className="text-sm">Embedding input</strong>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">{chunk.embedding_input ?? "Input was not recorded for this older index. Rebuild it to inspect the input."}</pre>
        <details><summary className="cursor-pointer text-sm">Original source</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{chunk.source_text}</pre></details>
        <details><summary className="cursor-pointer text-sm">Vector values</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(chunk.vector)}</pre></details>
      </article>)}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - page.limit))}>Previous</Button><Button variant="outline" disabled={offset + page.limit >= page.total} onClick={() => setOffset(offset + page.limit)}>Next</Button></div>
    </>}
  </section>;
}
