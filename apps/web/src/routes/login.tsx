import { englishMessage } from "@/lib/messages";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Eye,
  EyeOff,
  Layers3,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authClient } from "@/lib/auth-client";

function safeRedirect(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20]/.test(value)
  )
    return "/";
  const url = new URL(value, "https://local.invalid");
  return url.origin === "https://local.invalid" &&
    !/^\/login(?:\/|$)/.test(url.pathname)
    ? `${url.pathname}${url.search}${url.hash}`
    : "/";
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: safeRedirect(search.redirect),
  }),
  head: () => ({ meta: [{ title: "Sign in · Bottle" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { redirect } = Route.useSearch();
  const { data: session, isPending } = authClient.useSession();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<"email" | "github" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (session?.user) window.location.replace(redirect);
  }, [session?.user.id, redirect]);

  async function submitEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy("email");
    setError("");
    try {
      const address = email.trim();
      const result =
        mode === "login"
          ? await authClient.signIn.email({
              email: address,
              password,
              rememberMe: true,
            })
          : await authClient.signUp.email({
              name: address.split("@")[0],
              email: address,
              password,
            });
      if (result.error) {
        const messages: Record<string, string> = {
          INVALID_EMAIL_OR_PASSWORD:
            "Incorrect email or password. Please try again.",
          USER_ALREADY_EXISTS:
            "This email is already registered. Sign in instead.",
          USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
            "This email is already registered. Sign in instead.",
          PASSWORD_TOO_SHORT:
            "Your password must contain at least 8 characters.",
          TOO_MANY_REQUESTS: "Too many attempts. Please try again later.",
        };
        throw new Error(
          messages[result.error.code || ""] ||
            result.error.message ||
            "Unable to sign in. Please try again.",
        );
      }
      setPassword("");
      window.location.replace(redirect);
    } catch (cause) {
      setError(
        englishMessage(
          cause instanceof Error ? cause.message : null,
          "Connection failed. Check your network and try again.",
        ),
      );
      setBusy(null);
    }
  }

  async function signInGithub() {
    if (busy) return;
    setBusy("github");
    setError("");
    try {
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL: new URL(redirect, window.location.origin).href,
      });
      if (result.error)
        throw new Error(
          result.error.message || "GitHub sign-in failed. Please try again.",
        );
    } catch (cause) {
      setError(
        englishMessage(
          cause instanceof Error ? cause.message : null,
          "Unable to connect to GitHub. Please try again.",
        ),
      );
      setBusy(null);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="About Bottle">
        <Link to="/" search={{ q: "" }} className="login-brand">
          <span className="login-brand-icon">
            <Layers3 size={25} />
          </span>
          Bottle <span>RAG</span>
        </Link>
        <div className="login-story-content">
          <span className="login-eyebrow">Search. Ask. Verify.</span>
          <h1>
            Your documents.
            <br />
            Answers with sources.
          </h1>
          <p>
            Bottle is a RAG application for searching documents and answering
            questions with sources.
          </p>
          <div className="login-features">
            <div>
              <BookOpen size={21} />
              <span>
                <strong>Search your documents</strong>
                <small>Find relevant passages in your document library.</small>
              </span>
            </div>
            <div>
              <Layers3 size={21} />
              <span>
                <strong>Import from GitHub Stars</strong>
                <small>
                  Choose repositories and make their content searchable.
                </small>
              </span>
            </div>
            <div>
              <ShieldCheck size={21} />
              <span>
                <strong>Follow the sources</strong>
                <small>Inspect the passages behind each answer.</small>
              </span>
            </div>
          </div>
        </div>
        <p className="login-story-footer">
          Bottle · Search documents. Answer with sources.
        </p>
      </section>
      <section className="login-main" aria-label="Account sign-in">
        <Link to="/" search={{ q: "" }} className="login-back">
          <ArrowLeft size={16} />
          Back to workspace
        </Link>
        <Card className="login-card">
          {isPending || session?.user ? (
            <div className="login-loading" role="status">
              <Loader2 className="animate-spin" size={24} />
              {session?.user
                ? "Opening your workspace…"
                : "Checking your account…"}
            </div>
          ) : (
            <>
              <div className="login-heading">
                <span className="login-welcome">
                  <Check size={16} />
                  Your document workspace
                </span>
                <h2>
                  {mode === "login"
                    ? "Welcome to Bottle"
                    : "Create your Bottle account"}
                </h2>
                <p>
                  {mode === "login"
                    ? "Sign in to search your documents and explore the sources."
                    : "Create an account to start searching your documents."}
                </p>
              </div>
              <Tabs
                value={mode}
                onValueChange={(value) => {
                  setMode(value as "login" | "register");
                  setPassword("");
                  setShowPassword(false);
                  setError("");
                }}
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="login" disabled={!!busy}>
                    Sign in
                  </TabsTrigger>
                  <TabsTrigger value="register" disabled={!!busy}>
                    Create account
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <form
                onSubmit={submitEmail}
                className="login-form"
                aria-busy={!!busy}
              >
                <fieldset disabled={!!busy} className="login-fields">
                  <div>
                    <Label htmlFor="login-email">Email</Label>
                    <Input
                      id="login-email"
                      type="email"
                      required
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="login-password">Password</Label>
                    <div className="login-password">
                      <Input
                        id="login-password"
                        type={showPassword ? "text" : "password"}
                        required
                        minLength={mode === "register" ? 8 : 1}
                        maxLength={128}
                        autoComplete={
                          mode === "login" ? "current-password" : "new-password"
                        }
                        placeholder={
                          mode === "login"
                            ? "Enter your password"
                            : "At least 8 characters"
                        }
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={
                          showPassword ? "Hide password" : "Show password"
                        }
                        aria-pressed={showPassword}
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff size={17} />
                        ) : (
                          <Eye size={17} />
                        )}
                      </Button>
                    </div>
                    {mode === "register" && (
                      <p className="login-hint">
                        Use a mix of letters, numbers, and symbols.
                      </p>
                    )}
                  </div>
                </fieldset>
                {error && (
                  <div className="error-message" role="alert">
                    {englishMessage(error)}
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={!!busy}>
                  {busy === "email" ? (
                    <Loader2 className="animate-spin" size={17} />
                  ) : null}
                  {mode === "login" ? "Sign in" : "Create account"}
                  <ArrowRight size={16} />
                </Button>
              </form>
              <div className="login-divider">
                <span>or continue with</span>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={!!busy}
                onClick={signInGithub}
              >
                {busy === "github" ? (
                  <Loader2 className="animate-spin" size={17} />
                ) : (
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.3 11.3 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.4c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" />
                  </svg>
                )}
                Continue with GitHub
              </Button>
              <p className="login-note">
                To import GitHub Stars, continue with GitHub.
              </p>
            </>
          )}
        </Card>
        <p className="login-bottom">Documents, answers, sources。</p>
      </section>
    </main>
  );
}
