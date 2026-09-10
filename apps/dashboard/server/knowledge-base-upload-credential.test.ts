import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { apiCredentials, conversationTurns, knowledgeBaseBuilds, conversations } from "../drizzle/schema";
import { encryptApiKey, getDecryptedCredentialForKnowledgeBaseUploadReservation } from "./auth-service";
import { runWithEnterpriseProjectScope } from "./enterprise-project-context";
const key = process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY;
afterEach(() => { if (key === undefined) delete process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY; else process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY=key; });
describe("upload reservation credential identity", () => {
  it("reads the frozen retired credential for a non-default project and an authorized actor different from owner", async () => {
    process.env.FRONTMIND_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString("base64");
    const credential={id:"credential-test",userId:7,version:1,provider:"zhipu",status:"retired",fingerprint:"test",verifiedAt:null,...encryptApiKey(7,"credential-test","test-api-key")};
    const scope={enterpriseProjectId:"project-B",ownerUserId:7,actorUserId:99,isLegacyDefault:false};
    const turn={id:"turn",userId:7,conversationId:"eproject-B:session",clientRequestId:"request",buildId:"build",buildGeneration:1,apiCredentialId:credential.id,status:"queued",metadata:{awaitingClientAttachments:true,userAttachmentCount:0,sourceResetRevision:0,recovery:{attachmentManifest:[]}}};
    const db:any={transaction:(fn:any)=>fn(db), select:()=>({from:(table:any)=>({where:(predicate:any)=>({limit:()=>({for:async()=>{
      const params=new MySqlDialect().sqlToQuery(predicate).params;
      if(table===conversationTurns) return params.includes(turn.conversationId)?[turn]:[];
      if(table===knowledgeBaseBuilds) return [{id:"build",activeTurnId:"turn",status:"researching"}];
      if(table===conversations) return params.includes(turn.conversationId)?[{id:turn.conversationId,projectAssignmentId:null,deletedAt:null}]:[];
      if(table===apiCredentials) return [credential];
      return [];
    }})})})})};
    const result=await runWithEnterpriseProjectScope(scope,()=>getDecryptedCredentialForKnowledgeBaseUploadReservation({userId:7,conversationId:"session",turnId:"turn"},db));
    expect(result).toMatchObject({id:credential.id,status:"retired",apiKey:"test-api-key"});
  });
});
