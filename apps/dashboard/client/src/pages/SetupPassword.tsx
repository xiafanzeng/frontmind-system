import { FormEvent, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Loader2 } from "lucide-react";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { userFacingErrorMessage } from "@/lib/user-facing-error";

export default function SetupPassword() {
  const [, navigate] = useLocation();
  const token = useMemo(
    () =>
      new URLSearchParams(window.location.search).get("token")?.trim() || "",
    [],
  );
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");
  const setup = trpc.auth.setupAccount.useMutation();
  const validation = trpc.auth.validateSetupAccount.useQuery(
    { token },
    {
      enabled: Boolean(token),
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    if (!token) {
      setMessage("账号设置链接缺少一次性凭证，请返回官网重新查询开通状态。");
      return;
    }
    if (password !== confirmation) {
      setMessage("两次输入的密码不一致。");
      return;
    }
    try {
      await setup.mutateAsync({ token, newPassword: password });
    } catch (error) {
      setMessage(userFacingErrorMessage(error, "密码设置失败，请稍后重试。"));
    }
  };

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[radial-gradient(circle_at_top_left,#efe5f8,transparent_44%),linear-gradient(135deg,#fbf9fd,#f3eef7)] p-5">
      <section className="w-full max-w-md rounded-[28px] border border-white/80 bg-white/90 p-7 shadow-[0_24px_80px_rgba(65,30,92,.14)] backdrop-blur sm:p-9">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#5b2a86] text-white">
          {setup.isSuccess ? (
            <CheckCircle2 className="h-6 w-6" />
          ) : (
            <KeyRound className="h-6 w-6" />
          )}
        </div>
        <p className="mt-6 text-xs font-semibold tracking-[.16em] text-[#6b348f]">
          FRONTMIND 账号开通
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-[#171321]">
          {setup.isSuccess ? "密码已设置" : "设置登录密码"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[#716a80]">
          {setup.isSuccess
            ? "账号已完成激活，可以返回登录页进入服务首页。"
            : validation.data
              ? `${
                  validation.data.displayName ||
                  validation.data.username ||
                  "当前账号"
                }，请在有效期内设置密码。此链接使用后即失效，FrontMind 不会保存明文密码。`
              : "此链接为一次性凭证，有效期内设置密码后即失效。FrontMind 不会保存明文密码。"}
        </p>

        {setup.isSuccess ? (
          <Button
            className="mt-7 w-full bg-[#5b2a86] hover:bg-[#49216c]"
            onClick={() => navigate("/login")}
          >
            前往登录
          </Button>
        ) : validation.isError || (!token && !validation.isLoading) ? (
          <div className="mt-7">
            <p
              role="alert"
              className="rounded-xl bg-[#fff0f3] px-3 py-3 text-sm leading-6 text-[#a12b4d]"
            >
              {token
                ? validation.error?.message ||
                  "账号设置链接无效、已过期或已使用。"
                : "账号设置链接缺少一次性凭证。"}
            </p>
            <Button
              variant="outline"
              className="mt-4 w-full"
              onClick={() => navigate("/login")}
            >
              返回登录页
            </Button>
          </div>
        ) : validation.isLoading ? (
          <div
            className="mt-7 flex items-center justify-center gap-2 rounded-xl bg-[#f7f3fa] px-3 py-5 text-sm text-[#716a80]"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            正在校验账号设置链接…
          </div>
        ) : (
          <form className="mt-7 space-y-4" onSubmit={submit}>
            <label className="block text-sm font-medium text-[#484057]">
              新密码
              <Input
                className="mt-2"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={8}
                maxLength={128}
                required
              />
            </label>
            <label className="block text-sm font-medium text-[#484057]">
              再次输入
              <Input
                className="mt-2"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                minLength={8}
                maxLength={128}
                required
              />
            </label>
            {message && (
              <p
                role="alert"
                className="rounded-xl bg-[#fff0f3] px-3 py-2 text-sm text-[#a12b4d]"
              >
                {message}
              </p>
            )}
            <Button
              type="submit"
              className="w-full bg-[#5b2a86] hover:bg-[#49216c]"
              disabled={setup.isPending || !validation.data}
            >
              {setup.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              设置密码并激活
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
