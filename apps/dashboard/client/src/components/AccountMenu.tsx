import { useMemo, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import {
  ChevronUp,
  KeyRound,
  Loader2,
  LogOut,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/_core/hooks/useAuth";
import { isSystemAdminAccount } from "@/lib/admin-access";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "@shared/auth-constraints";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type AccountMenuProps = {
  collapsed?: boolean;
  onOpenSettings: () => void;
  onNavigate?: () => void;
};

export default function AccountMenu({
  collapsed = false,
  onOpenSettings,
  onNavigate,
}: AccountMenuProps) {
  const [, setLocation] = useLocation();
  const { user, logout, loading } = useAuth();
  const [passwordOpen, setPasswordOpen] = useState(false);

  const initials = useMemo(() => {
    const name = user?.displayName?.trim() || user?.username || "U";
    return Array.from(name).slice(0, 2).join("").toUpperCase();
  }, [user]);

  if (!user) return null;
  const isSystemAdmin = isSystemAdminAccount(user);

  const handleLogout = async () => {
    try {
      await logout();
      onNavigate?.();
      setLocation("/login", { replace: true });
    } catch (error) {
      toast.error("退出失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className={cn(
        "h-auto w-full text-muted-foreground hover:bg-card/70 hover:text-foreground",
        collapsed
          ? "justify-center px-0 py-1.5"
          : "justify-start gap-2 px-2 py-1.5",
      )}
      aria-label="账号菜单"
    >
      <Avatar className="h-7 w-7 border border-border/70">
        <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
          {initials}
        </AvatarFallback>
      </Avatar>
      {!collapsed && (
        <>
          <div className="min-w-0 flex-1 text-left">
            <p className="truncate text-xs font-medium text-foreground">
              {user.displayName || user.username}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              @{user.username}
            </p>
          </div>
          <ChevronUp className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </>
      )}
    </Button>
  );

  return (
    <>
      <DropdownMenu>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">账号菜单</TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        )}

        <DropdownMenuContent
          side={collapsed ? "right" : "top"}
          align="start"
          className="w-64"
        >
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-3 py-1">
              <Avatar className="h-9 w-9 border border-border/70">
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {user.displayName || user.username}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  @{user.username}
                </p>
              </div>
              <Badge variant="secondary" className="text-xs">
                {user.role === "admin" ? "管理员" : "用户"}
              </Badge>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              onOpenSettings();
              onNavigate?.();
            }}
          >
            <Settings />
            {isSystemAdmin
              ? "API Key 与积分"
              : user.role === "admin"
                ? "设置"
                : "智能服务设置"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPasswordOpen(true)}>
            <KeyRound />
            修改密码
          </DropdownMenuItem>
          {isSystemAdmin && (
            <DropdownMenuItem
              onSelect={() => {
                onNavigate?.();
                setLocation("/admin/users");
              }}
            >
              <Users />
              账号管理
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={loading}
            onSelect={(event) => {
              event.preventDefault();
              void handleLogout();
            }}
          >
            {loading ? <Loader2 className="animate-spin" /> : <LogOut />}
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </>
  );
}

function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const changePasswordMutation = trpc.auth.changePassword.useMutation();

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
    changePasswordMutation.reset();
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && changePasswordMutation.isPending) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!currentPassword || !newPassword || !confirmation) {
      toast.error("请填写所有密码字段");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(`新密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
      return;
    }
    if (newPassword !== confirmation) {
      toast.error("两次输入的新密码不一致");
      return;
    }
    if (newPassword === currentPassword) {
      toast.error("新密码不能与当前密码相同");
      return;
    }

    try {
      await changePasswordMutation.mutateAsync({
        currentPassword,
        newPassword,
      });
      toast.success("密码已更新，请重新登录");
      reset();
      onOpenChange(false);
      window.location.replace("/login");
    } catch (error) {
      toast.error("无法修改密码", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(calc(100vw-1rem),440px)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <ShieldCheck className="h-5 w-5 text-primary" />
            修改密码
          </DialogTitle>
          <DialogDescription>
            更新当前账号密码。请使用至少 {MIN_PASSWORD_LENGTH}{" "}
            个字符的独立密码。
          </DialogDescription>
        </DialogHeader>

        <form className="mt-2 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="current-password">当前密码</Label>
            <Input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={changePasswordMutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">新密码</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              disabled={changePasswordMutation.isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">确认新密码</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              minLength={MIN_PASSWORD_LENGTH}
              maxLength={MAX_PASSWORD_LENGTH}
              disabled={changePasswordMutation.isPending}
            />
          </div>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={changePasswordMutation.isPending}
            >
              取消
            </Button>
            <Button type="submit" disabled={changePasswordMutation.isPending}>
              {changePasswordMutation.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              保存新密码
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
