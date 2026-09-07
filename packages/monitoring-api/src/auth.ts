import type { Request } from "express";

/** Authentication is supplied by the Dashboard; this module never owns sessions. */
export type AuthenticatedUser = {
  id: string;
  username: string;
  role: "user" | "admin";
  status: "active" | "disabled";
};
export interface AuthenticationService {
  syncAccounts?(): Promise<void>;
  resolve(request: Request): Promise<{
    user: AuthenticatedUser;
    auditActor?: { id: string; role: "user" | "admin" };
    session: null;
    tokenHash: null;
  } | null>;
}
