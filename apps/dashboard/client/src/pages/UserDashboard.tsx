import UserBrandDashboard from "@/dashboard/UserBrandDashboard";

export default function UserDashboard({
  initialSection = "brand",
}: {
  initialSection?: "brand" | "knowledge-agent";
}) {
  return <UserBrandDashboard initialSection={initialSection} />;
}
