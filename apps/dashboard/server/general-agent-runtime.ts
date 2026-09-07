import {
  generalAgentModelProfileEffort,
  generalAgentModelProfileSchema,
  type GeneralAgentModelProfile,
} from "../shared/manus-agent-profile";

/** New tasks follow the administrator's frozen credential configuration. */
export function generalAgentRuntimeForCredential(credential: {
  provider: string;
  upstreamModel: string;
  upstreamEffort: string | null;
}) {
  const effort = credential.upstreamEffort;
  if (
    credential.provider !== "zhipu" ||
    credential.upstreamModel !== "glm-5.3" ||
    (effort !== "low" && effort !== "high" && effort !== "max")
  ) {
    throw new Error("GENERAL_AGENT_CREDENTIAL_RUNTIME_INVALID");
  }
  const publicProfile: GeneralAgentModelProfile =
    effort === "low"
      ? "frontmind-lite"
      : effort === "high"
        ? "frontmind-base"
        : "frontmind-pro";
  return {
    publicProfile,
    upstreamModel: "glm-5.3" as const,
    upstreamEffort: effort,
    speed: "standard" as const,
  };
}

/** Existing tasks retain the profile frozen when their operation was created. */
export function generalAgentRuntimeForOperation(operation: {
  upstreamModel: string;
  publicProfile: unknown;
}) {
  const publicProfile = generalAgentModelProfileSchema.parse(
    operation.publicProfile,
  );
  return {
    publicProfile,
    upstreamModel: operation.upstreamModel,
    upstreamEffort: generalAgentModelProfileEffort(publicProfile),
    speed: "standard" as const,
  };
}

/** Only new general conversations accept a user's choice. The operation freezes it. */
export function generalAgentRuntimeForSelection(
  credential: Parameters<typeof generalAgentRuntimeForCredential>[0],
  profile: unknown = "frontmind-base",
) {
  generalAgentRuntimeForCredential(credential);
  return generalAgentRuntimeForOperation({
    upstreamModel: credential.upstreamModel,
    publicProfile: generalAgentModelProfileSchema.parse(profile),
  });
}
