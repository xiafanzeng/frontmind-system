import { z } from "zod";

export const managedAgentProfileSchema = z.enum([
  "frontmind-base",
  "frontmind-pro",
]);

export type ManagedAgentProfile = z.infer<typeof managedAgentProfileSchema>;

export const DEFAULT_MANAGED_AGENT_PROFILE: ManagedAgentProfile =
  "frontmind-pro";

export function normalizeManagedAgentProfile(
  value: unknown,
): ManagedAgentProfile {
  return value === "frontmind-base"
    ? "frontmind-base"
    : DEFAULT_MANAGED_AGENT_PROFILE;
}

export function managedAgentProfileModel(profile: ManagedAgentProfile) {
  return profile === "frontmind-base" ? "manus-1.6" : "manus-1.6-max";
}

/**
 * Public model choice for the delivery administrator/engineer general Agent.
 * This is deliberately separate from a customer's Base/Pro service profile:
 * an internal Key authenticates the request while each new Agent task freezes
 * its own Lite/Base/Pro choice.
 */
export const generalAgentModelProfileSchema = z.enum([
  "frontmind-lite",
  "frontmind-base",
  "frontmind-pro",
]);

export type GeneralAgentModelProfile = z.infer<
  typeof generalAgentModelProfileSchema
>;

export const DEFAULT_GENERAL_AGENT_MODEL_PROFILE: GeneralAgentModelProfile =
  "frontmind-pro";

export function generalAgentModelProfileModel(
  profile: GeneralAgentModelProfile,
) {
  if (profile === "frontmind-lite") return "manus-1.6-lite" as const;
  if (profile === "frontmind-base") return "manus-1.6" as const;
  return "manus-1.6-max" as const;
}
