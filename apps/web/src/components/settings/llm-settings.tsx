import { useAutosave } from "./use-autosave";
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/api";
import { englishMessage } from "@/lib/messages";

type Config = {
  answer_enabled: boolean;
  rerank_enabled: boolean;
  search_mode: "fast" | "balanced" | "quality";
  model: string;
  base_url: string;
  timeout: number;
  has_api_key: boolean;
  embedding_summary_enabled: boolean;
  github_summary_prompt: string;
  document_summary_prompt: string;
  summary_prompt_defaults: { github: string; document: string };
};
export type LlmSection = "connection" | "search" | "preprocessing";
export function LlmSettings({ section = "connection", onPendingChange }: { section?: LlmSection; onPendingChange?: (pending: boolean) => void }) {
  const [saved, setSaved] = useState<Config | null>(null);
  const [answerEnabled, setAnswerEnabled] = useState(false);
  const [searchMode, setSearchMode] = useState<Config["search_mode"]>("balanced");
  const [rerankEnabled, setRerankEnabled] = useState(true);
  const [summaryEnabled, setSummaryEnabled] = useState(false);
  const [scenario, setScenario] = useState<"github" | "document">("github");
  const [githubPrompt, setGithubPrompt] = useState("");
  const [documentPrompt, setDocumentPrompt] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [timeout, setTimeoutValue] = useState("60");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetchJson<Config>("/api/settings/llm", { signal: controller.signal })
      .then((config) => {
        if (controller.signal.aborted) return;
        setSaved(config);
        setAnswerEnabled(config.answer_enabled);
        setRerankEnabled(config.rerank_enabled);
        setSearchMode(config.search_mode ?? "balanced");
        setSummaryEnabled(config.embedding_summary_enabled);
        setGithubPrompt(config.github_summary_prompt);
        setDocumentPrompt(config.document_summary_prompt);
        setModel(config.model);
        setBaseUrl(config.base_url);
        setTimeoutValue(String(config.timeout));
        setKey("");
        setClearKey(false);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(englishMessage(cause.message));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);
  const keepsKey =
    saved?.has_api_key &&
    saved.base_url === baseUrl.trim().replace(/\/+$/, "") &&
    !clearKey;
  async function submit(action: "save" | "test") {
    if (busy || !saved) return false;
    setError("");
    setNotice("");
    if ((answerEnabled || summaryEnabled || action === "test") && !model.trim()) {
      setError("Enter an LLM model ID.");
      return false;
    }
    if (!githubPrompt.trim() || !documentPrompt.trim()) {
      setError("Enter a summary prompt for each scenario.");
      return false;
    }
    const seconds = Number(timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
      setError("Timeout must be greater than 0 and at most 300 seconds.");
      return false;
    }
    setBusy(action);
    try {
      const result = await fetchJson<Config>(
        `/api/settings/llm${action === "test" ? "/test" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answer_enabled: answerEnabled,
            rerank_enabled: rerankEnabled,
            search_mode: searchMode,
            embedding_summary_enabled: summaryEnabled,
            github_summary_prompt: githubPrompt.trim(),
            document_summary_prompt: documentPrompt.trim(),
            model: model.trim(),
            base_url: baseUrl.trim(),
            api_key: clearKey ? "" : key || null,
            timeout: seconds,
          }),
        },
      );
      if (action === "save") {
        setSaved(result);
        setKey("");
        setClearKey(false);
      }
      setNotice(
        action === "test"
          ? "Connection successful."
          : "Settings saved. Future LLM requests will use this configuration.",
      );
      return true;
    } catch (cause) {
      setError(englishMessage(cause instanceof Error ? cause.message : null));
      return false;
    } finally {
      setBusy(null);
    }
  }
  const autosave = useAutosave(() => submit("save"), !!busy);
  useEffect(() => { onPendingChange?.(autosave.pending); }, [autosave.pending, onPendingChange]);
  return (
    <section
      className="grid gap-5 rounded-2xl border bg-card p-5 sm:p-7"
      aria-labelledby="llm-heading"
    >
      <header>
        <h2 id="llm-heading" className="text-lg font-semibold">
          {section === "connection" ? "Model connection" : section === "search" ? "Search & answers" : "Document preprocessing"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {section === "connection" ? "Connect the language model used across Bottle." : section === "search" ? "Choose how results are ranked and answers are generated." : "Prepare source content for semantic search."}
        </p>
      </header>
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading settings…
        </p>
      ) : !saved ? (
        <>
          <p role="alert">{error}</p>
          <Button
            variant="outline"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry
          </Button>
        </>
      ) : (
        <form
          className="grid gap-5"
          onChange={(event) => { if ((event.target as HTMLElement).id !== "summary-scenario") { setNotice(""); autosave.changed(); } }}
          onSubmit={(event) => {
            event.preventDefault();
            autosave.changed();
          }}
        >
          <fieldset disabled={!!busy} className="grid min-w-0 gap-5">
            <div hidden={section !== "connection"} style={section !== "connection" ? { display: "none" } : undefined} className="grid gap-5">
            <div>
              <Label htmlFor="llm-url" className="mb-2 block">
                Base URL
              </Label>
              <Input
                id="llm-url"
                type="url"
                required
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Use the API base path, without /chat/completions.
              </p>
            </div>
            <div>
              <Label htmlFor="llm-model" className="mb-2 block">
                Model
              </Label>
              <Input
                id="llm-model"
                required={answerEnabled || summaryEnabled}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Your provider's chat model ID"
              />
            </div>
            <div>
              <Label htmlFor="llm-key" className="mb-2 block">
                API key
              </Label>
              <Input
                id="llm-key"
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setClearKey(false);
                }}
                placeholder={
                  keepsKey
                    ? "Leave blank to keep the saved key"
                    : "Enter an API key if required"
                }
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Your key is saved on the server and never returned to the
                browser. Changing the Base URL requires a new key.
              </p>
              {saved.has_api_key && (
                <Button
                  type="button"
                  variant="ghost"
                  className="mt-2"
                  onClick={() => {
                    setClearKey((value) => !value);
                    autosave.changed();
                    setKey("");
                  }}
                >
                  {clearKey ? "Keep saved key" : "Remove saved key"}
                </Button>
              )}
            </div>
            <div>
              <Label htmlFor="llm-timeout" className="mb-2 block">
                Timeout (seconds)
              </Label>
              <Input
                id="llm-timeout"
                type="number"
                min="1"
                max="300"
                value={timeout}
                onChange={(event) => setTimeoutValue(event.target.value)}
              />
            </div>
            </div>
            <div hidden={section !== "search"} style={section !== "search" ? { display: "none" } : undefined} className="grid gap-5">
            <div className="grid gap-3">
              <h3 className="font-medium">Search relevance</h3>
              <Label htmlFor="search-mode">Speed and quality</Label>
              <select id="search-mode" className="h-9 rounded-md border bg-background px-3 text-sm"
                value={searchMode} onChange={(event) => setSearchMode(event.target.value as Config["search_mode"])}>
                <option value="fast">Fast — hybrid retrieval, no LLM reranking</option>
                <option value="balanced">Balanced — up to 8 candidates, 1s model timeout</option>
                <option value="quality">Quality — up to 20 candidates, 5s model timeout</option>
              </select>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1 accent-primary" checked={rerankEnabled}
                  onChange={(event) => setRerankEnabled(event.target.checked)} />
                <span>Rerank search results by query intent</span>
              </label>
              <p className="text-xs text-muted-foreground">
                Uses the configured model to verify candidate relevance. Independent of answers and summaries.
                Balanced and quality modes add one LLM request per uncached search. Timeouts fall back to hybrid ranking.
                Fast mode skips this request. Embedding time is additional.
                Takes effect once a model is configured.
              </p>
            </div>
            <div className="grid gap-3 border-t pt-5">
              <h3 className="font-medium">Answers</h3>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={answerEnabled}
                onChange={(event) => setAnswerEnabled(event.target.checked)}
              />
              <span>
                <span className="font-medium">
                  Answer generation
                </span>
                <span className="mt-1 block text-muted-foreground">
                  Generate answers from retrieved content. This setting does not affect document summaries.
                </span>
              </span>
            </label>
            </div>
            </div>
            <div hidden={section !== "preprocessing"} style={section !== "preprocessing" ? { display: "none" } : undefined} className="grid gap-3">
              <h3 className="font-medium">Source summaries</h3>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1 accent-primary" checked={summaryEnabled}
                  onChange={(event) => setSummaryEnabled(event.target.checked)} />
                <span>Use this LLM to summarize source content before generating embeddings.</span>
              </label>
              <p className="text-xs text-muted-foreground">
                Independent of answer generation. Summaries use English plain text, up to 100 words.
                Original passages remain available for search results and citations.
                First-time processing adds LLM requests and may incur charges.
              </p>
              <Label htmlFor="summary-scenario">Scenario</Label>
              <select id="summary-scenario" className="h-9 rounded-md border bg-background px-3 text-sm"
                value={scenario} onChange={(event) => setScenario(event.target.value as "github" | "document")}>
                <option value="github">GitHub repositories</option>
                <option value="document">Local documents</option>
              </select>
              <Label htmlFor="summary-prompt">Summary prompt</Label>
              <Textarea id="summary-prompt" rows={7} maxLength={6000} required
                value={scenario === "github" ? githubPrompt : documentPrompt}
                onChange={(event) => scenario === "github" ? setGithubPrompt(event.target.value) : setDocumentPrompt(event.target.value)} />
              <Button type="button" variant="outline" className="justify-self-start"
                onClick={() => { scenario === "github" ? setGithubPrompt(saved.summary_prompt_defaults.github) : setDocumentPrompt(saved.summary_prompt_defaults.document); autosave.changed(); }}>
                Restore default prompt
              </Button>
              <p className="text-xs text-muted-foreground">
                Customize what matters for this scenario. Changes are saved automatically.
                Rebuild existing indexes to regenerate their summaries and embeddings.
              </p>
            </div>
          </fieldset>
          <p className="rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
            Depending on the feature, questions, retrieved passages, or document
            content may be sent to this API. Requests and connection tests may
            incur provider charges. Answer generation uses the updated settings
            immediately; applying changes to preprocessing for existing indexes
            requires rebuilding those indexes.
          </p>
          <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {busy === "save" ? "Saving changes…" : autosave.pending ? "Unsaved changes" : "All changes saved automatically"}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="flex items-start gap-2 text-sm text-primary"
            >
              <Check size={16} className="shrink-0" />
              {notice}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              hidden={section !== "connection"}
              disabled={!!busy}
              onClick={() => void submit("test")}
            >
              {busy === "test" && (
                <Loader2 size={16} className="animate-spin" />
              )}
              Test connection
            </Button>
            {error && autosave.pending && (
              <Button type="button" variant="outline" disabled={!!busy} onClick={autosave.changed}>
                Retry saving
              </Button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
