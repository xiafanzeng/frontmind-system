import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { lazy, Suspense } from "react";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import { Loader2, RefreshCw } from "lucide-react";
import { Redirect, Route, Switch, useLocation } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ConversationProvider } from "./contexts/ConversationContext";
import { useResumePolling } from "./hooks/useResumePolling";
import {
  ADMIN_WORKSPACE_TAB_IDS,
  type WorkspaceTab,
} from "./lib/admin-workspace-tabs";
import SetupPassword from "./pages/SetupPassword";
import {
  isDeliveryAdminAccount,
  isSystemAdminAccount,
} from "@/lib/admin-access";
import { hasExplicitAdminRole } from "@shared/admin-access";
import { userFacingErrorMessage } from "@/lib/user-facing-error";

const UserDashboard = lazy(() =>
  import("./pages/UserDashboard").then(({ default: component }) => ({
    default: component,
  })),
);
const AdminDashboard = lazy(() =>
  import("./pages/AdminDashboard").then(({ default: component }) => ({
    default: component,
  })),
);
const AdminAgent = lazy(() =>
  import("./pages/AdminAgent").then(({ default: component }) => ({
    default: component,
  })),
);
const AdminWorkspace = lazy(() =>
  import("./pages/AdminWorkspace").then(({ default: component }) => ({
    default: component,
  })),
);
const AdminUsers = lazy(() =>
  import("./pages/AdminUsers").then(({ default: component }) => ({
    default: component,
  })),
);
const AdminPresales = lazy(() =>
  import("./pages/AdminPresales").then(({ default: component }) => ({
    default: component,
  })),
);
const AdminDeliveryRoles = lazy(() =>
  import("./pages/AdminDeliveryRoles").then(({ default: component }) => ({
    default: component,
  })),
);
const DeliveryMemberDashboard = lazy(() =>
  import("./pages/DeliveryMemberDashboard").then(({ default: component }) => ({
    default: component,
  })),
);
const DeliveryMemberAgent = lazy(() =>
  import("./pages/DeliveryMemberAgent").then(({ default: component }) => ({
    default: component,
  })),
);
const AdminDeliveryDispatch = lazy(() =>
  import("./pages/AdminDeliveryDispatch").then(({ default: component }) => ({
    default: component,
  })),
);

const DevelopmentPreviewRouter = import.meta.env.DEV
  ? lazy(() => import("./pages/DevelopmentPreviewRouter"))
  : null;

export function adminHomePath(
  user: Parameters<typeof isSystemAdminAccount>[0],
): "/" | "/admin/workspace" | null {
  if (isSystemAdminAccount(user)) return "/";
  if (isDeliveryAdminAccount(user)) return "/admin/workspace";
  return null;
}

function RoleLanding() {
  const { user } = useAuth();
  const adminHome = adminHomePath(user);
  if (adminHome === "/") return <AdminDashboard />;
  if (adminHome === "/admin/workspace") {
    return <Redirect to="/admin/workspace" />;
  }
  if (user?.role === "delivery_member") return <DeliveryMemberDashboard />;
  return <UserDashboard />;
}

export function canAccessAdminRoutes(
  user:
    | {
        role: "user" | "admin" | "delivery_member";
        adminAccessLevel?: "system_admin" | "delivery_admin" | null;
      }
    | null
    | undefined,
) {
  return Boolean(user && hasExplicitAdminRole(user));
}

export function canAccessSystemAdminRoutes(
  user:
    | {
        role: "user" | "admin" | "delivery_member";
        adminAccessLevel?: "system_admin" | "delivery_admin" | null;
      }
    | null
    | undefined,
) {
  return Boolean(
    user?.role === "admin" && user.adminAccessLevel === "system_admin",
  );
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return canAccessAdminRoutes(user) ? children : <Redirect to="/" />;
}

function SystemAdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return canAccessSystemAdminRoutes(user) ? children : <Redirect to="/" />;
}

function DeliveryAdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return isDeliveryAdminAccount(user) ? children : <Redirect to="/" />;
}

function UserOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user?.role === "user" ? children : <Redirect to="/" />;
}

function DeliveryMemberOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user?.role === "delivery_member" ? children : <Redirect to="/" />;
}

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={RoleLanding} />
      <Route path={"/login"} component={RoleLanding} />
      <Route path={"/agent"}>
        <DeliveryAdminOnly>
          <Redirect to="/admin/agent" />
        </DeliveryAdminOnly>
      </Route>
      <Route path={"/admin/agent"}>
        <DeliveryAdminOnly>
          <AdminAgent />
        </DeliveryAdminOnly>
      </Route>
      <Route path={"/knowledge-base"}>
        <UserOnly>
          <UserDashboard initialSection="knowledge-agent" />
        </UserOnly>
      </Route>
      <Route path={"/admin/workspace"}>
        <AdminOnly>
          <AdminWorkspace />
        </AdminOnly>
      </Route>
      <Route path={"/admin/customers/:userId/:tab"}>
        {(params) => {
          const userId = Number(params.userId);
          if (!Number.isInteger(userId) || userId <= 0) return <NotFound />;
          const allowedTabs: readonly WorkspaceTab[] = ADMIN_WORKSPACE_TAB_IDS;
          if (!allowedTabs.includes(params.tab as WorkspaceTab)) {
            return <Redirect to={`/admin/customers/${userId}/service`} />;
          }
          const initialTab = params.tab as WorkspaceTab;
          return (
            <AdminOnly>
              <AdminWorkspace initialUserId={userId} initialTab={initialTab} />
            </AdminOnly>
          );
        }}
      </Route>
      <Route path={"/admin/users"}>
        <AdminOnly>
          <AdminUsers />
        </AdminOnly>
      </Route>
      <Route path={"/admin/presales"}>
        <SystemAdminOnly>
          <AdminPresales />
        </SystemAdminOnly>
      </Route>
      <Route path={"/admin/delivery-roles"}>
        <AdminOnly>
          <AdminDeliveryRoles />
        </AdminOnly>
      </Route>
      <Route path={"/admin/dispatch"}>
        <AdminOnly>
          <AdminDeliveryDispatch />
        </AdminOnly>
      </Route>
      <Route path={"/admin/delivery-workbench"}>
        <SystemAdminOnly>
          <DeliveryMemberDashboard customerWorkbench systemAdminMode />
        </SystemAdminOnly>
      </Route>
      <Route path={"/delivery/agent"}>
        <DeliveryMemberOnly>
          <DeliveryMemberAgent />
        </DeliveryMemberOnly>
      </Route>
      <Route path={"/delivery/workbench"}>
        <DeliveryMemberOnly>
          <DeliveryMemberDashboard customerWorkbench />
        </DeliveryMemberOnly>
      </Route>
      <Route path={"/delivery/tasks"}>
        <DeliveryMemberOnly>
          <Redirect to="/" />
        </DeliveryMemberOnly>
      </Route>
      <Route path={"/workflow"}>
        <Redirect to="/" />
      </Route>
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

/**
 * Inner app shell that has access to ConversationProvider context.
 * Activates the resume-polling hook so that conversations stuck in
 * "running" state after page reload / tab switch are automatically
 * recovered.
 */
function AppShell({ resumePolling = true }: { resumePolling?: boolean }) {
  // CRITICAL FIX: Resume polling for stuck "running" conversations
  return (
    <>
      {resumePolling && <ConversationResumePolling />}
      <Suspense
        fallback={
          <div className="flex min-h-[100dvh] items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
              正在载入工作空间
            </div>
          </div>
        }
      >
        <Router />
      </Suspense>
    </>
  );
}

function ConversationResumePolling() {
  useResumePolling();
  return null;
}

export function AuthBoundary() {
  const { user, loading, error, refresh } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          正在打开工作空间
        </div>
      </div>
    );
  }

  if (!user && error) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
        <div className="glass-card w-full max-w-sm rounded-2xl p-7 text-center">
          <h1 className="text-lg font-semibold">暂时无法连接服务</h1>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {userFacingErrorMessage(error, "请检查网络连接后重试。")}
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" />
            重新连接
          </Button>
        </div>
      </div>
    );
  }

  if (!user) return <Login />;

  if (user.role === "delivery_member") {
    return <AppShell resumePolling={false} />;
  }

  return (
    <ConversationProvider>
      <AppShell />
    </ConversationProvider>
  );
}

function App() {
  const [location] = useLocation();
  const previewPage =
    import.meta.env.DEV &&
    DevelopmentPreviewRouter &&
    location.startsWith("/preview/") ? (
      <Suspense
        fallback={
          <div className="flex min-h-[100dvh] items-center justify-center text-sm text-muted-foreground">
            正在载入验收页面…
          </div>
        }
      >
        <DevelopmentPreviewRouter location={location} />
      </Suspense>
    ) : null;
  const publicPage = location === "/setup-password" ? <SetupPassword /> : null;

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster position="top-center" />
          {previewPage || publicPage || <AuthBoundary />}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
