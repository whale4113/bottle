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
  head: () => ({ meta: [{ title: "登录 · 知屿" }] }),
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
          INVALID_EMAIL_OR_PASSWORD: "邮箱或密码不正确，请重新输入。",
          USER_ALREADY_EXISTS: "这个邮箱已注册，请切换到登录。",
          USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
            "这个邮箱已注册，请切换到登录。",
          PASSWORD_TOO_SHORT: "密码至少需要 8 位。",
          TOO_MANY_REQUESTS: "操作太频繁，请稍后再试。",
        };
        throw new Error(
          messages[result.error.code || ""] ||
            result.error.message ||
            "暂时无法登录，请稍后重试。",
        );
      }
      setPassword("");
      window.location.replace(redirect);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "连接失败，请检查网络后重试。",
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
          result.error.message || "GitHub 登录失败，请稍后重试。",
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "无法连接 GitHub，请稍后重试。",
      );
      setBusy(null);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="关于知屿">
        <Link to="/" className="login-brand">
          <span className="login-brand-icon">
            <Layers3 size={25} />
          </span>
          知屿 <span>Knowledge</span>
        </Link>
        <div className="login-story-content">
          <span className="login-eyebrow">你的个人知识空间</span>
          <h1>
            让收藏的知识，
            <br />
            成为随手可用的答案。
          </h1>
          <p>连接文档与 GitHub 收藏，在每一次提问中，重新发现知识的价值。</p>
          <div className="login-features">
            <div>
              <BookOpen size={21} />
              <span>
                <strong>让文档开口说话</strong>
                <small>从你的知识库中找到答案与出处</small>
              </span>
            </div>
            <div>
              <Layers3 size={21} />
              <span>
                <strong>让收藏不再沉睡</strong>
                <small>同步所选 Stars，找到合适的工具</small>
              </span>
            </div>
            <div>
              <ShieldCheck size={21} />
              <span>
                <strong>让每个答案有据可循</strong>
                <small>回到原始来源，保留自己的判断</small>
              </span>
            </div>
          </div>
        </div>
        <p className="login-story-footer">知屿 · 让每一份知识，都有回响</p>
      </section>
      <section className="login-main" aria-label="账户登录">
        <Link to="/" className="login-back">
          <ArrowLeft size={16} />
          返回工作空间
        </Link>
        <Card className="login-card">
          {isPending || session?.user ? (
            <div className="login-loading" role="status">
              <Loader2 className="animate-spin" size={24} />
              {session?.user ? "正在进入工作空间…" : "正在检查登录状态…"}
            </div>
          ) : (
            <>
              <div className="login-heading">
                <span className="login-welcome">
                  <Check size={16} />
                  知识，从连接开始
                </span>
                <h2>
                  {mode === "login" ? "欢迎回到知屿" : "开启你的知识空间"}
                </h2>
                <p>
                  {mode === "login"
                    ? "登录账户，继续探索你的知识库。"
                    : "创建账户，开始整理与发现。"}
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
                    登录
                  </TabsTrigger>
                  <TabsTrigger value="register" disabled={!!busy}>
                    创建账户
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
                    <Label htmlFor="login-email">邮箱</Label>
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
                    <Label htmlFor="login-password">密码</Label>
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
                          mode === "login" ? "输入你的密码" : "至少 8 位密码"
                        }
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={showPassword ? "隐藏密码" : "显示密码"}
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
                        建议混合使用字母、数字与符号。
                      </p>
                    )}
                  </div>
                </fieldset>
                {error && (
                  <div className="error-message" role="alert">
                    {error}
                  </div>
                )}
                <Button type="submit" className="w-full" disabled={!!busy}>
                  {busy === "email" ? (
                    <Loader2 className="animate-spin" size={17} />
                  ) : null}
                  {mode === "login" ? "登录" : "创建账户"}
                  <ArrowRight size={16} />
                </Button>
              </form>
              <div className="login-divider">
                <span>或使用以下方式</span>
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
                使用 GitHub 继续
              </Button>
              <p className="login-note">
                想同步 GitHub Stars？请选择 GitHub 登录。
              </p>
            </>
          )}
        </Card>
        <p className="login-bottom">连接知识，发现答案。</p>
      </section>
    </main>
  );
}
