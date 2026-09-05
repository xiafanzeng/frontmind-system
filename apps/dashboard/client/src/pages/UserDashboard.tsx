import UserBrandDashboard from "@/dashboard/UserBrandDashboard";

export default function UserDashboard({
  initialSection = "brand",
}: {
  initialSection?: "brand" | "knowledge-agent" | "monitoring";
}) {
  return <UserBrandDashboard initialSection={initialSection} />;
}
