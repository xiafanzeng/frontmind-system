import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { userFacingErrorMessage } from "@/lib/user-facing-error";

const LOGIN_BACKGROUND = "/assets/frontmind-login-background.webp";
const WORDMARK = "/assets/frontmind-wordmark.svg";
const CUHKSZ_EMBLEM = "/assets/cuhksz-emblem.png";

export default function Login() {
  const [, setLocation] = useLocation();
  const { login, loginPending } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      toast.error("请输入用户名和密码");
      return;
    }

    try {
      await login(normalizedUsername, password);
      setLocation("/", { replace: true });
    } catch (error) {
      const message = userFacingErrorMessage(error, "登录失败，请稍后重试");
      toast.error("无法登录", {
        description: message.includes("用户名")
          ? "用户名或密码不正确"
          : message,
      });
    }
  };

  return (
    <main className="relative grid min-h-[100dvh] w-full overflow-hidden bg-[#f4f5f8] lg:grid-cols-[minmax(0,1.75fr)_minmax(420px,0.9fr)]">
      <section
        aria-label="FrontMind 智能体工作流"
        className="relative hidden overflow-hidden bg-[#f5f4f9] lg:block"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 translate-y-7 scale-[1.08] bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: `url(${LOGIN_BACKGROUND})` }}
        />
        <div className="absolute inset-x-8 top-[22%] flex flex-col items-center text-center text-[#31283a]">
          <img
            src={WORDMARK}
            alt="FrontMind"
            className="h-auto w-[min(50vw,480px)]"
          />
          <div className="mt-10 h-[3px] w-16 rounded-full bg-[#19bfc5]" />
          <h1 className="mt-7 tracking-wide">
            <span className="block text-[34px] font-semibold leading-tight">
              与 FrontMind 一起，
            </span>
            <span className="mt-3 block text-[28px] font-normal leading-tight text-[#31283a]">
              构筑科研驱动的企业级 GEO 基建
            </span>
          </h1>
          <div className="mt-12 flex items-center gap-3 text-left">
            <img
              src={CUHKSZ_EMBLEM}
              alt="香港中文大学（深圳）校徽"
              className="h-12 w-12 shrink-0 rounded-full"
            />
            <p className="text-[17px] font-medium tracking-wide text-[#43384b]">
              香港中文大学（深圳）AI智能决策实验室
            </p>
          </div>
        </div>
      </section>

      <section className="relative flex min-h-[100dvh] items-center justify-center px-5 py-8 sm:px-8 lg:bg-[#f7f7fa]">
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center bg-no-repeat lg:hidden"
          style={{ backgroundImage: `url(${LOGIN_BACKGROUND})` }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-white/76 backdrop-blur-[3px] lg:hidden"
        />

        <div className="relative z-10 w-full max-w-[400px] overflow-hidden rounded-lg border border-[#e7e1eb] bg-white shadow-[0_18px_50px_rgb(51_33_61/0.12)]">
          <header className="bg-[#f4eff8] px-8 pb-6 pt-8 sm:px-9">
            <img
              src={WORDMARK}
              alt="FrontMind"
              className="h-auto w-[210px] max-w-full"
            />
            <div className="mt-5 flex items-end justify-between gap-4">
              <div>
                <h2 className="text-base font-medium tracking-wide text-[#31283a]">
                  账号密码登录
                </h2>
                <div className="mt-3 h-0.5 w-7 bg-[#6820a0]" />
              </div>
              <p className="pb-3 text-xs text-[#7d7484]">FrontMind 工作空间</p>
            </div>
          </header>

          <div className="px-8 pb-7 pt-6 sm:px-9">
            <form className="space-y-4" onSubmit={handleSubmit}>
              <div>
                <Label className="sr-only" htmlFor="username">
                  用户名
                </Label>
                <Input
                  id="username"
                  name="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="请输入用户名"
                  disabled={loginPending}
                  className="h-[42px] rounded-[4px] border-[#ddd7e2] bg-white px-3 text-sm shadow-none placeholder:text-[#a9a2ad] focus-visible:border-[#6a2096] focus-visible:ring-[#6a2096]/15"
                  autoFocus
                />
              </div>

              <div>
                <Label className="sr-only" htmlFor="password">
                  密码
                </Label>
                <Input
                  id="password"
                  name="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="current-password"
                  placeholder="请输入密码"
                  disabled={loginPending}
                  className="h-[42px] rounded-[4px] border-[#ddd7e2] bg-white px-3 text-sm shadow-none placeholder:text-[#a9a2ad] focus-visible:border-[#6a2096] focus-visible:ring-[#6a2096]/15"
                />
              </div>

              <Button
                type="submit"
                className="mt-2 h-[42px] w-full gap-2 rounded-[4px] bg-[#641b96] text-white shadow-none hover:bg-[#511278] focus-visible:ring-[#641b96]/25"
                disabled={loginPending}
              >
                {loginPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {loginPending ? "正在登录" : "登录"}
              </Button>
            </form>

            <p
              data-testid="presales-login-hint"
              className="mt-5 text-center text-xs leading-6 text-[#8f8795]"
            >
              请
              <a
                href="https://www.frontmind.net"
                className="mx-1 inline-flex rounded-[4px] bg-[#641b96] px-2 py-0.5 font-medium text-white transition-colors hover:bg-[#511278] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#641b96]/30"
              >
                返回官网
              </a>
              完成售前流程，使用售前分配的账号登录。
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
