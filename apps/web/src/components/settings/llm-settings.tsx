import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/api";
import { englishMessage } from "@/lib/messages";

type Config = {
  enabled: boolean;
  model: string;
  base_url: string;
  timeout: number;
  has_api_key: boolean;
};
export function LlmSettings() {
  const [saved, setSaved] = useState<Config | null>(null);
  const [enabled, setEnabled] = useState(false);
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
        setEnabled(config.enabled);
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
    if (busy || !saved) return;
    setError("");
    setNotice("");
    if ((enabled || action === "test") && !model.trim()) {
      setError("Enter an answer model ID.");
      return;
    }
    const seconds = Number(timeout);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
      setError("Timeout must be greater than 0 and at most 300 seconds.");
      return;
    }
    setBusy(action);
    try {
      const result = await fetchJson<Config>(
        `/api/settings/llm${action === "test" ? "/test" : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
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
          ? "Connection successful. Settings have not been saved."
          : "Settings saved. Your next search will use this configuration.",
      );
    } catch (cause) {
      setError(englishMessage(cause instanceof Error ? cause.message : null));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section
      className="grid gap-5 rounded-2xl border bg-card p-5 sm:p-7"
      aria-labelledby="llm-heading"
    >
      <header>
        <h2 id="llm-heading" className="text-lg font-semibold">
          Answer model
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate answers from retrieved documents using an OpenAI-compatible
          LLM API.
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
          onChange={() => setNotice("")}
          onSubmit={(event) => {
            event.preventDefault();
            void submit("save");
          }}
        >
          <fieldset disabled={!!busy} className="grid min-w-0 gap-5">
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-primary"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>
                <span className="font-medium">
                  Generate answers with an LLM
                </span>
                <span className="mt-1 block text-muted-foreground">
                  When disabled, Bottle shows retrieved evidence and answer
                  drafts.
                </span>
              </span>
            </label>
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
                required={enabled}
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
          </fieldset>
          <p className="rounded-lg bg-muted/50 p-3 text-xs leading-relaxed text-muted-foreground">
            Your question and retrieved passages are sent to this API.
            Connection tests send a short sample and may incur provider charges.
            Changing the answer model does not require reindexing documents.
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
              disabled={!!busy}
              onClick={() => void submit("test")}
            >
              {busy === "test" && (
                <Loader2 size={16} className="animate-spin" />
              )}
              Test connection
            </Button>
            <Button type="submit" disabled={!!busy}>
              {busy === "save" && (
                <Loader2 size={16} className="animate-spin" />
              )}
              Save settings
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
