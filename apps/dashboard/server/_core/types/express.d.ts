import type {
  AuthenticatedUser,
  DecryptedCredential,
} from "../../auth-service";
import type { DeliveryRoleType } from "../../../shared/delivery-roles";

declare global {
  namespace Express {
    interface Request {
      frontmindUser?: AuthenticatedUser;
      frontmindCredential?: DecryptedCredential;
      frontmindDeliveryProjectContext?: {
        projectAssignmentId: string;
        customerUserId: number;
        roleType: DeliveryRoleType;
        customerName: string;
      };
    }
  }
}

export {};
