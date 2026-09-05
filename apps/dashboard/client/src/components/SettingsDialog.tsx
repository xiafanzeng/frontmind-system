import { Settings } from "lucide-react";

import { useAuth } from "@/_core/hooks/useAuth";
import { isSystemAdminAccount } from "@/lib/admin-access";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SettingsDialog({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const { user } = useAuth();
  const systemAdministrator = isSystemAdminAccount(user);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(calc(100vw-1rem),460px)] max-w-[calc(100vw-1rem)] border-border/50 p-5 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8 text-lg">
            <Settings className="h-5 w-5 text-primary" />
            智能服务设置
          </DialogTitle>
          <DialogDescription className="text-sm leading-6 text-muted-foreground">
            {systemAdministrator
              ? "请前往“API 与人员管理”统一配置所有账号 API Key，并查看经过完整扫描证明的近 30 天用量。"
              : "API Key 由系统管理员统一维护，您可以直接使用当前账号已开放的功能。"}
          </DialogDescription>
        </DialogHeader>
        {systemAdministrator && (
          <div className="rounded-xl border border-primary/15 bg-primary/5 p-4 text-sm leading-6">
            个人设置不再提供 Key
            写入、本月积分或任务明细，避免与系统管理员工作台产生两套口径。
          </div>
        )}
        <div className="flex justify-end">
          <Button type="button" onClick={() => onOpenChange(false)}>
            知道了
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
