import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fetchJson } from "@/lib/api";
import { englishMessage } from "@/lib/messages";

type Configuration = {
  provider: "local" | "openai" | "voyage";
  model: string;
  base_url: string;
  dimensions: number | null;
  timeout: number;
  has_api_key: boolean;
  reindex_required: boolean;
};
export function EmbeddingSettings() {
  const open = true;
  const [saved, setSaved] = useState<Configuration | null>(null);
  const [provider, setProvider] = useState<Configuration["provider"]>("local");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [dimensions, setDimensions] = useState("");
  const [timeout, setTimeoutValue] = useState("60");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setNotice("");
    setApiKey("");
    setClearKey(false);
    setSaved(null);
    void fetchJson<Configuration>("/api/settings/embedding", {
      signal: controller.signal,
    })
      .then((config) => {
        if (controller.signal.aborted) return;
        setSaved(config);
        setProvider(config.provider);
        setModel(config.model);
        setBaseUrl(config.base_url);
        setDimensions(config.dimensions?.toString() || "");
        setTimeoutValue(String(config.timeout));
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            englishMessage(cause instanceof Error ? cause.message : null),
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, reload]);

  const keepsKey =
    !!saved?.has_api_key &&
    saved.provider === provider &&
    saved.base_url === baseUrl.trim().replace(/\/+$/, "") &&
    !clearKey;

  async function submit(action: "save" | "test") {
    if (busy || !saved) return;
    if (!model.trim()) {
      setError("Enter an embedding model name.");
      return;
    }
    const requestedDimensions = dimensions ? Number(dimensions) : null;
    const requestedTimeout = Number(timeout);
    if (
      provider === "openai" &&
      requestedDimensions !== null &&
      (!Number.isSafeInteger(requestedDimensions) ||
        requestedDimensions < 1 ||
        requestedDimensions > 65536)
    ) {
      setError("Dimensions must be an integer between 1 and 65536.");
      return;
    }
    if (
      !Number.isFinite(requestedTimeout) ||
      requestedTimeout <= 0 ||
      requestedTimeout > 300
    ) {
      setError("Timeout must be greater than 0 and at most 300 seconds.");
      return;
    }
    setBusy(action);
    setError("");
    setNotice("");
    try {
      const payload = {
        provider,
        model: model.trim(),
        base_url: baseUrl.trim(),
        api_key: clearKey ? "" : apiKey || null,
        dimensions: provider === "openai" ? requestedDimensions : null,
        timeout: requestedTimeout,
      };
      if (action === "test") {
        const result = await fetchJson<{ status: string; dimensions: number }>(
          "/api/settings/embedding/test",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        setNotice(
          `Connection successful. Returned ${result.dimensions} dimensions. Settings have not been saved.`,
        );
      } else {
        const config = await fetchJson<Configuration>(
          "/api/settings/embedding",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        setSaved(config);
        setApiKey("");
        setClearKey(false);
        setNotice(
          config.reindex_required
            ? "Settings saved. Reimport your GitHub documents from Library to use this model."
            : "Settings saved. Your next search will use this model.",
        );
      }
    } catch (cause) {
      setError(englishMessage(cause instanceof Error ? cause.message : null));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className="grid gap-5 rounded-2xl border bg-card p-5 sm:p-7"
      aria-labelledby="embedding-heading"
    >
      <header>
        <h2 id="embedding-heading" className="text-lg font-semibold">
          Embeddings
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose how Bottle indexes documents and retrieves relevant passages.
        </p>
      </header>
      {loading ? (
        <div
          className="flex items-center gap-2 py-8 text-sm text-muted-foreground"
          role="status"
        >
          <Loader2 className="animate-spin" size={18} />
          Loading settings…
        </div>
      ) : !saved ? (
        <>
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
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
          onSubmit={(event) => {
            event.preventDefault();
            void submit("save");
          }}
        >
          <fieldset disabled={!!busy} className="grid min-w-0 gap-5">
            <div>
              <Label className="mb-2 block">Embedding provider</Label>
              <Tabs
                value={provider}
                onValueChange={(value) => {
                  setProvider(value as Configuration["provider"]);
                  setModel(
                    value === saved.provider
                      ? saved.model
                      : value === "local"
                        ? "Qwen/Qwen3-Embedding-0.6B"
                        : "text-embedding-3-small",
                  );
                  setError("");
                  setNotice("");
                }}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="local">Local model</TabsTrigger>
                  <TabsTrigger value="openai">
                    OpenAI-compatible API
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            {provider === "voyage" && (
              <p className="text-xs text-muted-foreground">
                Voyage is currently configured through the server environment.
                Choose Local model or OpenAI-compatible API to save a personal
                configuration.
              </p>
            )}
            <div>
              <Label htmlFor="embedding-model" className="mb-2 block">
                Model
              </Label>
              <Input
                id="embedding-model"
                required
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={
                  provider === "local"
                    ? "Model ID or local model path"
                    : "text-embedding-3-small"
                }
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {provider === "local"
                  ? "Runs on the Bottle server. Enter a Sentence Transformers model ID or a local model path. The first use may download the model."
                  : "Enter the embedding model ID supported by your API provider."}
              </p>
            </div>
            {provider === "openai" && (
              <>
                <div>
                  <Label htmlFor="embedding-url" className="mb-2 block">
                    Base URL
                  </Label>
                  <Input
                    id="embedding-url"
                    type="url"
                    required
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.openai.com/v1"
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    Use the API base path, without /embeddings.
                  </p>
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <Label htmlFor="embedding-key">API key</Label>
                    {keepsKey && (
                      <span className="text-xs text-muted-foreground">
                        Saved key will be kept
                      </span>
                    )}
                  </div>
                  <Input
                    id="embedding-key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => {
                      setApiKey(event.target.value);
                      setClearKey(false);
                    }}
                    placeholder={
                      keepsKey
                        ? "Leave blank to keep the saved key"
                        : "Enter an API key if required"
                    }
                  />
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Your key is saved on the server and is never returned to the
                    browser. Changing the Base URL requires a new key.
                  </p>
                  {saved.has_api_key && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mt-1"
                      onClick={() => {
                        setClearKey(!clearKey);
                        setApiKey("");
                      }}
                    >
                      {clearKey ? "Keep saved key" : "Remove saved key"}
                    </Button>
                  )}
                </div>
                <details className="rounded-lg border p-3 text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    Advanced options
                  </summary>
                  <div className="mt-4 grid gap-4">
                    <div>
                      <Label
                        htmlFor="embedding-dimensions"
                        className="mb-2 block"
                      >
                        Dimensions (optional)
                      </Label>
                      <Input
                        id="embedding-dimensions"
                        type="number"
                        min={1}
                        max={65536}
                        step={1}
                        value={dimensions}
                        onChange={(event) => setDimensions(event.target.value)}
                        placeholder="Model default"
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Leave blank unless your API supports custom dimensions.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="embedding-timeout" className="mb-2 block">
                        Request timeout (seconds)
                      </Label>
                      <Input
                        id="embedding-timeout"
                        type="number"
                        required
                        min={1}
                        max={300}
                        value={timeout}
                        onChange={(event) =>
                          setTimeoutValue(event.target.value)
                        }
                      />
                    </div>
                  </div>
                </details>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Document passages and search queries are sent to this API to
                  create embeddings.
                </p>
              </>
            )}
          </fieldset>
          <p className="rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
            Changing the provider, model, Base URL, or dimensions requires
            reimporting existing GitHub documents. Local documents are indexed
            with the selected model on the next search.
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
              <Check className="mt-1 shrink-0" size={15} />
              {notice}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={!!busy || provider === "voyage"}
              onClick={() => void submit("test")}
            >
              {busy === "test" && (
                <Loader2 className="animate-spin" size={16} />
              )}
              Test connection
            </Button>
            <Button type="submit" disabled={!!busy || provider === "voyage"}>
              {busy === "save" && (
                <Loader2 className="animate-spin" size={16} />
              )}
              Save settings
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
