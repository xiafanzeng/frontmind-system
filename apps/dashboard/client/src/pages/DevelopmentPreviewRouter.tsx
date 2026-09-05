import { Redirect } from "wouter";

import { ConversationProvider } from "@/contexts/ConversationContext";
import { PreviewUserBrandDashboard } from "@/dashboard/UserBrandDashboard";
import {
  adminDashboardPreviewFixtures,
  userPreviewFixtures,
} from "@/lib/development-preview-fixtures";
import {
  previewAdminPageHref,
  previewAdminRootHref,
  previewAdminWorkspaceHref,
} from "@/lib/preview-navigation";
import AdminDashboard from "@/pages/AdminDashboard";
import KnowledgeBaseLivePreview from "@/pages/KnowledgeBaseLivePreview";
import KnowledgeBaseProductionAcceptance from "@/pages/KnowledgeBaseProductionAcceptance";
import {
  PreviewAdminAccounts,
  PreviewAdminAgent,
  PreviewAdminDeliveryRoles,
  PreviewAdminDispatch,
  PreviewAdminPresales,
  PreviewAdminUsers,
} from "@/pages/PreviewPages";

type DevelopmentPreviewRouterProps = {
  location: string;
};

type PreviewPlanCode = "basic" | "advanced" | "luxury";

function PreviewUserRoute({ planCode }: { planCode?: PreviewPlanCode }) {
  return (
    <ConversationProvider>
      <PreviewUserBrandDashboard
        initialSection="brand"
        planCode={planCode}
        fixtures={userPreviewFixtures}
      />
    </ConversationProvider>
  );
}

/**
 * Development/acceptance-only routes.
 *
 * App imports this module behind an import.meta.env.DEV guarded dynamic
 * import. Do not import it from a production route or authenticated feature.
 */
export default function DevelopmentPreviewRouter({
  location,
}: DevelopmentPreviewRouterProps) {
  const route = location.split("?")[0];

  switch (route) {
    case "/preview/knowledge-base-live":
      return <KnowledgeBaseProductionAcceptance />;
    case "/preview/knowledge-base-upstream-probe":
      return <KnowledgeBaseLivePreview />;
    case "/preview/user":
      return <PreviewUserRoute />;
    case "/preview/user/basic":
      return <PreviewUserRoute planCode="basic" />;
    case "/preview/user/advanced":
      return <PreviewUserRoute planCode="advanced" />;
    case "/preview/user/luxury":
      return <PreviewUserRoute planCode="luxury" />;
    case "/preview/admin":
      return <Redirect to={previewAdminRootHref("system_admin")} />;
    case "/preview/admin/delivery":
      return <Redirect to={previewAdminWorkspaceHref("delivery_admin")} />;
    case "/preview/admin/system":
      return (
        <AdminDashboard
          preview
          previewAccessLevel="system_admin"
          previewFixtures={adminDashboardPreviewFixtures}
        />
      );
    case previewAdminWorkspaceHref("delivery_admin"):
      return <PreviewAdminUsers previewAccessLevel="delivery_admin" />;
    case previewAdminWorkspaceHref("system_admin"):
      return <PreviewAdminUsers previewAccessLevel="system_admin" />;
    case previewAdminPageHref("delivery_admin", "delivery-roles"):
      return <PreviewAdminDeliveryRoles previewAccessLevel="delivery_admin" />;
    case previewAdminPageHref("system_admin", "delivery-roles"):
      return <PreviewAdminDeliveryRoles previewAccessLevel="system_admin" />;
    case previewAdminPageHref("delivery_admin", "dispatch"):
      return <PreviewAdminDispatch previewAccessLevel="delivery_admin" />;
    case previewAdminPageHref("system_admin", "dispatch"):
      return <PreviewAdminDispatch previewAccessLevel="system_admin" />;
    case previewAdminPageHref("delivery_admin", "agent"):
      return <PreviewAdminAgent previewAccessLevel="delivery_admin" />;
    case previewAdminPageHref("system_admin", "agent"):
      return <Redirect to={previewAdminRootHref("system_admin")} />;
    case previewAdminPageHref("system_admin", "presales"):
      return <PreviewAdminPresales />;
    case previewAdminPageHref("system_admin", "accounts"):
      return <PreviewAdminAccounts previewAccessLevel="system_admin" />;
    case previewAdminPageHref("delivery_admin", "accounts"):
      return <PreviewAdminAccounts previewAccessLevel="delivery_admin" />;
    case "/preview/admin/agent":
      return <Redirect to={previewAdminRootHref("system_admin")} />;
    case "/preview/admin/workflow":
      return <Redirect to={previewAdminRootHref("system_admin")} />;
    case "/preview/admin/presales":
      return <Redirect to={previewAdminPageHref("system_admin", "presales")} />;
    case "/preview/admin/users":
      return <Redirect to={previewAdminWorkspaceHref("system_admin")} />;
    case "/preview/admin/delivery-roles":
      return (
        <Redirect to={previewAdminPageHref("system_admin", "delivery-roles")} />
      );
    case "/preview/admin/dispatch":
      return <Redirect to={previewAdminPageHref("system_admin", "dispatch")} />;
    case "/preview/admin/accounts":
      return <Redirect to={previewAdminPageHref("system_admin", "accounts")} />;
    default:
      return null;
  }
}
