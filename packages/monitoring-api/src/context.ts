import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { Request, Response } from "express";
import type { AuthenticatedUser } from "./auth.js";
import type { RuntimeConfig } from "@frontmind/monitoring-config";
import type { MonitoringRepository, PublishingRepository } from "@frontmind/monitoring-db";
import type { PaymentConfiguration } from "@frontmind/monitoring-payment";
import type { AuthenticationService } from "./auth.js";
import { hashNetworkIdentifier } from "./security.js";

export type ApiContext = ApiDependencies & {
  request: Request;
  response: Response;
  user: AuthenticatedUser | null;
  session: null;
  tokenHash: null;
  audit: { actorId: string | null; actorRole: "user" | "admin" | null; ipHash: string | null };
};

export type ApiDependencies = {
  repository: MonitoringRepository;
  publishingRepository?: PublishingRepository;
  auth: AuthenticationService;
  config: RuntimeConfig;
  paymentConfiguration: PaymentConfiguration;
  paymentFetchImpl?: typeof fetch;
  paymentNow?: () => Date;
};

export async function createContext(
  options: CreateExpressContextOptions,
  dependencies: ApiDependencies,
): Promise<ApiContext> {
  const authenticated = await dependencies.auth.resolve(options.req);
  return {
    ...dependencies,
    request: options.req,
    response: options.res,
    user: authenticated?.user ?? null,
    session: authenticated?.session ?? null,
    tokenHash: authenticated?.tokenHash ?? null,
    audit: {
      actorId: authenticated?.auditActor?.id ?? authenticated?.user.id ?? null,
      actorRole: authenticated?.auditActor?.role ?? authenticated?.user.role ?? null,
      ipHash: hashNetworkIdentifier(
        options.req.ip,
        dependencies.config.SESSION_SECRET,
      ),
    },
  };
}
