import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { lazy, Suspense } from "react";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";
import { Loader2, RefreshCw } from "lucide-react";
import { Redirect, Route, Router as BrowserRouter, Switch, useLocation, useSearch } from "wouter";
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
import { WorkspaceQueryProvider } from "./contexts/WorkspaceQueryProvider";
import { useWorkspaceLocation } from "./hooks/useWorkspaceLocation";
import { isEnterpriseWorkspacePath, projectWorkspaceUrl } from "./lib/enterprise-project";

const MonitoringDemo = lazy(() => import("./monitoring/MonitoringDemo"));
const KnowledgeFrontendSettings = lazy(
  () => import("./dashboard/knowledge-frontend/KnowledgeFrontendSettings"),
);
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

const MonitoringModule = lazy(() => import("./monitoring/Workspace"));

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
  const search = useSearch();
  if (
    user?.role === "admin" &&
    /^\d+$/.test(new URLSearchParams(search).get("operatorOwnerId") || "")
  )
    return <UserDashboard />;
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
  const search = useSearch();
  return user?.role === "user" ||
    (canAccessAdminRoutes(user) &&
      /^\d+$/.test(
        new URLSearchParams(search).get("operatorOwnerId") || "",
      )) ? (
    children
  ) : (
    <Redirect to="/" />
  );
}

export function GeneralAgentLanding() {
  const { user } = useAuth();
  if (user?.role === "user") return <UserDashboard />;
  return isDeliveryAdminAccount(user) ? (
    <Redirect to="/admin/agent" />
  ) : user?.role === "delivery_member" ? (
    <Redirect to="/delivery/agent" />
  ) : (
    <Redirect to="/" />
  );
}

function MonitoringCustomerOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user?.role === "user" ||
    isSystemAdminAccount(user) ||
    (user?.role === "admin" &&
      /^\d+$/.test(
        new URLSearchParams(window.location.search).get("operatorOwnerId") ||
          "",
      )) ? (
    children
  ) : (
    <Redirect to="/" />
  );
}

function DeliveryMemberOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user?.role === "delivery_member" ? children : <Redirect to="/" />;
}

function Router() {
  const { user } = useAuth();
  const [pathname] = useLocation();
  const search = useSearch();
  const mirrored = canAccessAdminRoutes(user) && /^\d+$/.test(new URLSearchParams(search).get("operatorOwnerId") || "");
  const customerRoute = isEnterpriseWorkspacePath(pathname) || pathname === "/agent" || pathname === "/account";
  // A single component identity keeps the sidebar and shell in place across module routes.
  if (customerRoute && (user?.role === "user" || (mirrored && pathname !== "/agent") || (isSystemAdminAccount(user) && /^\/(monitoring-system|publishing)(?:\/|$)/.test(pathname)))) {
    return <UserDashboard />;
  }
  return (
    <Switch>
      <Route path={"/"} component={RoleLanding} />
      <Route path={"/login"} component={RoleLanding} />
      <Route path="/monitoring-system">
        <MonitoringCustomerOnly>
          <UserDashboard />
        </MonitoringCustomerOnly>
      </Route>
      <Route path="/monitoring-system/*">
        <MonitoringCustomerOnly>
          <UserDashboard />
        </MonitoringCustomerOnly>
      </Route>
      <Route path="/publishing">
        <MonitoringCustomerOnly>
          <UserDashboard />
        </MonitoringCustomerOnly>
      </Route>
      <Route path="/publishing/*">
        <MonitoringCustomerOnly>
          <UserDashboard />
        </MonitoringCustomerOnly>
      </Route>
      <Route path="/admin/monitoring">
        <SystemAdminOnly>
          <MonitoringModule />
        </SystemAdminOnly>
      </Route>
      <Route path="/admin/monitoring/*">
        <SystemAdminOnly>
          <MonitoringModule />
        </SystemAdminOnly>
      </Route>
      <Route path={"/agent"}>
        <GeneralAgentLanding />
      </Route>
      <Route path="/account">
        <UserOnly>
          <UserDashboard />
        </UserOnly>
      </Route>
      <Route path={"/enterprise-qa"}>
        <UserOnly>
          <UserDashboard />
        </UserOnly>
      </Route>
      <Route path={"/content-production"}>
        <UserOnly>
          <UserDashboard />
        </UserOnly>
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
            const query =
              typeof window === "undefined" ? "" : window.location.search;
            return (
              <Redirect to={`/admin/customers/${userId}/workspace${query}`} />
            );
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

export function WorkspaceLoadingState() {
  return (
    <div
      className="flex min-h-[100dvh] items-center justify-center bg-background"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
          <Loader2
            className="h-5 w-5 animate-spin text-primary"
            aria-hidden="true"
          />
        </div>
        正在打开工作空间
      </div>
    </div>
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
      <Suspense fallback={<WorkspaceLoadingState />}>
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
    return <WorkspaceLoadingState />;
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
    return <WorkspaceQueryProvider userId={user.id}><AppShell resumePolling={false} /></WorkspaceQueryProvider>;
  }

  return (
    <WorkspaceQueryProvider userId={user.id}>
      <ConversationProvider>
        <AppShell />
      </ConversationProvider>
    </WorkspaceQueryProvider>
  );
}

function AppContent() {
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
  const publicPage =
    location === "/setup-password" ? (
      <SetupPassword />
    ) : location === "/monitoring" ? (
      <Suspense fallback={<WorkspaceLoadingState />}>
        <MonitoringDemo />
      </Suspense>
    ) : location === "/knowledge-frontend-demo" ? (
      <Suspense fallback={<WorkspaceLoadingState />}>
        <div className="knowledge-frontend-demo">
          <KnowledgeFrontendSettings demo ownerId="demo" projectId="demo" />
        </div>
      </Suspense>
    ) : null;

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

function App() {
  return <BrowserRouter hook={useWorkspaceLocation} hrefs={href => projectWorkspaceUrl(href)}><AppContent /></BrowserRouter>;
}

export default App;
