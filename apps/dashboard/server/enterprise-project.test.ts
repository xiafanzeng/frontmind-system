import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { knowledgeBaseBuilds } from "../drizzle/schema";
import { requestEnterpriseProjectId } from "./enterprise-project-request";
import { enterpriseOwnerPredicate, runWithEnterpriseProjectScope } from "./enterprise-project-scope";
import { enterpriseConversationStoragePrefix } from "./enterprise-conversation-storage";
import { runWithoutEnterpriseProjectScope } from "./enterprise-project-context";
const projectId = "fd3fe2f4-3ff4-4d2d-a17c-539005c8b52e";
const otherProjectId = "27742ba7-9c6c-4dc5-8730-e2b8e91c63eb";
const scope = { enterpriseProjectId: projectId, ownerUserId: 101, actorUserId: 103, isLegacyDefault: false };
const dialect = new MySqlDialect();

describe("enterprise project boundaries", () => {
  it("validates both download query and fetch header and rejects ambiguous selectors", () => {
    expect(requestEnterpriseProjectId({query:{enterpriseProjectId:projectId}})).toBe(projectId);
    expect(requestEnterpriseProjectId({headers:{"x-enterprise-project-id":projectId}})).toBe(projectId);
    expect(() => requestEnterpriseProjectId({headers:{"x-enterprise-project-id":projectId},query:{enterpriseProjectId:otherProjectId}})).toThrow();
    expect(() => requestEnterpriseProjectId({headers:{"x-enterprise-project-id":[projectId]}})).toThrow();
    expect(requestEnterpriseProjectId()).toBeNull();
  });
  it("isolates owner and project, keeping account-level null rows outside legacy defaults", () => {
    const query = runWithEnterpriseProjectScope(scope, () => dialect.sqlToQuery(enterpriseOwnerPredicate(knowledgeBaseBuilds,101)));
    expect(query.params).toEqual([101,projectId]);
    expect(query.sql).not.toContain("is null");
    expect(() => runWithEnterpriseProjectScope(scope, () => enterpriseOwnerPredicate(knowledgeBaseBuilds,102))).toThrow("OWNER_MISMATCH");
    const legacy = runWithEnterpriseProjectScope({...scope,isLegacyDefault:true}, () => dialect.sqlToQuery(enterpriseOwnerPredicate(knowledgeBaseBuilds,101)));
    expect(legacy.sql).not.toContain("is null");
  });
  it("keeps concurrent async scopes independent and can restore account scope", async () => {
    const read = async (id:string) => runWithEnterpriseProjectScope({...scope,enterpriseProjectId:id}, async () => { await Promise.resolve(); return enterpriseConversationStoragePrefix(101); });
    expect(await Promise.all([read(projectId),read(otherProjectId)])).toEqual([`e${projectId}:`,`e${otherProjectId}:`]);
    expect(runWithEnterpriseProjectScope(scope, () => runWithoutEnterpriseProjectScope(() => enterpriseConversationStoragePrefix(101)))).toBe("u101:");
    expect(runWithEnterpriseProjectScope({...scope,isLegacyDefault:true}, () => enterpriseConversationStoragePrefix(101))).toBe("u101:");
  });
});

const acceptanceUrl = process.env.FRONTMIND_ENTERPRISE_PROJECT_TEST_DATABASE_URL;
describe.skipIf(!acceptanceUrl)("enterprise project MySQL acceptance", () => {
  it("migrates history, keeps a new account empty, isolates project questions, and freezes monitoring provenance", async () => {
    const url = new URL(acceptanceUrl!);
    if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.startsWith('/fm_project_acceptance_operator')) throw new Error('A disposable local enterprise acceptance database is required');
    process.env.DATABASE_URL = acceptanceUrl;
    process.env.NODE_ENV = "test";
    const {getDb} = await import('./db');
    const {eq,and} = await import('drizzle-orm');
    const schema = await import('../drizzle/schema');
    const {createDefaultDashboardPayload} = await import('../shared/dashboard');
    const service = await import('./enterprise-project-service');
    const questions = await import('./enterprise-project-questions');
    const {createEnterpriseMonitoringProject,getEnterpriseMonitoringProgress} = await import('./enterprise-project-monitoring');
    const {applyQuestionMaintenance} = await import('./question-maintenance-service');
    const db = (await getDb())!;
    const actor = {id:101,username:'acceptance_operator',displayName:'既有操作员',role:'user' as const};
    const stranger = {id:102,username:'acceptance_other',displayName:'隔离账号',role:'user' as const};
    const admin = {id:103,username:'acceptance_admin',displayName:'管理员',role:'admin' as const,adminAccessLevel:'system_admin' as const};
    const initial = await service.listEnterpriseProjects(actor);
    const legacy = initial.projects.find(project => project.isLegacyDefault)!;
    expect(legacy).toBeDefined();
    const [oldContent] = await db.select().from(schema.enterpriseProjectDashboardContents).where(eq(schema.enterpriseProjectDashboardContents.enterpriseProjectId,legacy.id));
    expect(oldContent?.revision).toBe(7);
    expect(oldContent?.payload.brandName).toBe('历史品牌');
    const newUsername = `fresh-${randomUUID().slice(0,12)}`;
    await db.insert(schema.users).values({username:newUsername,role:'user'});
    const [fresh] = await db.select().from(schema.users).where(eq(schema.users.username,newUsername));
    expect((await service.listEnterpriseProjects({...actor,id:fresh!.id,username:newUsername})).projects).toHaveLength(0);
    const requestId = randomUUID();
    const created = await Promise.all([service.createEnterpriseProject(actor,{name:'甲企业',clientRequestId:requestId}),service.createEnterpriseProject(actor,{name:'甲企业',clientRequestId:requestId})]);
    expect(created[0].id).toBe(created[1].id);
    const projectA = created[0];
    const projectB = await service.createEnterpriseProject(actor,{name:'乙企业',clientRequestId:randomUUID()});
    await expect(service.resolveEnterpriseProjectScope(stranger,projectA.id)).rejects.toThrow();
    expect((await service.resolveEnterpriseProjectScope(admin,projectA.id)).ownerUserId).toBe(101);
    const scoped = {...scope,enterpriseProjectId:projectA.id,actorUserId:actor.id};
    const selected = await runWithEnterpriseProjectScope(scoped, () => questions.selectEnterpriseQuestion({userId:101,actorUserId:101,question:'甲企业适合哪些客户？',category:'industry',clientRequestId:randomUUID()}));
    const aPortal = await runWithEnterpriseProjectScope(scoped, () => questions.getEnterpriseToolPortal(101));
    expect(aPortal.quotas).toBeNull();
    expect(aPortal.service.planCode).toBeNull();
    expect(aPortal.purchasedQuestions.map(row=>row.id)).toContain(selected.id);
    expect(await runWithEnterpriseProjectScope({...scoped,enterpriseProjectId:projectB.id}, () => questions.listEnterpriseQuestions(101))).toHaveLength(0);
    const monitorRequest = {enterpriseProjectId:projectA.id,name:'优化问题监控',questionIds:[selected.id],clientRequestId:randomUUID()};
    const monitoring = await createEnterpriseMonitoringProject(actor,monitorRequest);
    expect(await createEnterpriseMonitoringProject(actor,monitorRequest)).toEqual(monitoring);
    // Free-typed monitoring questions become selected user questions inline;
    // mixed sources dedupe identical text and survive request replay.
    const customMonitorRequest = {enterpriseProjectId:projectA.id,name:'自定义监控',questionIds:[selected.id],customQuestions:['甲企业在搜索结果里的口碑如何？','甲企业适合哪些客户？'],clientRequestId:randomUUID()};
    const customMonitoring = await createEnterpriseMonitoringProject(actor,customMonitorRequest);
    expect(customMonitoring.questions).toContain('甲企业在搜索结果里的口碑如何？');
    expect(await createEnterpriseMonitoringProject(actor,customMonitorRequest)).toEqual(customMonitoring);
    const customOnly = await createEnterpriseMonitoringProject(actor,{enterpriseProjectId:projectA.id,name:'纯自定义监控',questionIds:[],customQuestions:['新问题唯一'],clientRequestId:randomUUID()});
    expect(customOnly.questions).toEqual(['新问题唯一']);
    await expect(createEnterpriseMonitoringProject(actor,{enterpriseProjectId:projectA.id,name:'空监控',questionIds:[],customQuestions:[],clientRequestId:randomUUID()})).rejects.toThrow();
    const customPortal = await runWithEnterpriseProjectScope(scoped, () => questions.listEnterpriseQuestions(101));
    expect(customPortal.map(row=>row.question)).toContain('甲企业在搜索结果里的口碑如何？');
    const {getMonitoringRuntime} = await import('./monitoring-module');
    const {ensureDashboardAccountLink,monitors,runWithMonitoringEnterpriseScope} = await import('@frontmind/monitoring-db');
    const runtime = getMonitoringRuntime();
    const accountLink = await ensureDashboardAccountLink(runtime.repository.db,actor.id);
    const monitorId = randomUUID();
    await runtime.repository.db.insert(monitors).values({id:monitorId,ownerId:accountLink.monitoringUserId,projectId:monitoring.projectId,name:'scope acceptance monitor'});
    const readMonitors = (enterpriseProjectId:string) => runWithMonitoringEnterpriseScope({enterpriseProjectId,ownerId:accountLink.monitoringUserId}, () => runtime.repository.listMonitors(accountLink.monitoringUserId));
    expect((await readMonitors(projectA.id)).map(row=>row.id)).toContain(monitorId);
    expect(await readMonitors(projectB.id)).toHaveLength(0);
    const {runWithStoredEnterpriseProjectScope} = await import('./enterprise-project-recovery');
    expect(await runWithStoredEnterpriseProjectScope(101,projectA.id, () => enterpriseConversationStoragePrefix(101))).toBe(`e${projectA.id}:`);
    await expect(runWithStoredEnterpriseProjectScope(102,projectA.id, () => true)).rejects.toThrow('OWNER_MISMATCH');

    const modified = await runWithEnterpriseProjectScope(scoped, () => applyQuestionMaintenance({actor,value:{action:'modify',questionId:selected.id,expectedRevision:selected.revision,clientRequestId:randomUUID(),proposedQuestion:'甲企业的新问题是什么？',reason:'调整目标问题'}}));
    expect(modified.replacementQuestionId).toBeTruthy();
    const progress = await getEnterpriseMonitoringProgress(actor,projectA.id);
    expect(progress.projects.find(row=>row.id===monitoring.projectId)?.sourceQuestions[0]?.question).toBe('甲企业适合哪些客户？');
    expect((await getEnterpriseMonitoringProgress(actor,projectB.id)).projects).toHaveLength(0);
    // A historical default-project transport must retain its existing provider
    // session after cutover; project B and account-level general cannot see it.
    const credentialId = randomUUID();
    await db.insert(schema.apiCredentials).values({id:credentialId,userId:101,version:1,provider:"zhipu",encryptedKey:"synthetic-acceptance-placeholder",encryptionIv:"0".repeat(24),encryptionAuthTag:"0".repeat(32),fingerprint:randomUUID().replaceAll("-","")});
    const intentId = `legacy-runtime-${randomUUID()}`;
    const binding = createHash("sha256").update(JSON.stringify(["dashboard-zhipu-transport",101,credentialId,1,intentId])).digest("hex");
    const operationId = randomUUID(), localTaskId = randomUUID(), sessionId = `acceptance-session-${randomUUID()}`;
    await db.insert(schema.agentOperations).values({id:operationId,provider:"zhipu",scope:"managed_user",accountUserId:101,enterpriseProjectId:legacy.id,operationType:"dashboard.provider.transport",idempotencyKeyHash:binding,requestHash:binding,contractName:"dashboard.provider.transport",contractRevision:1,schemaHash:"a".repeat(64),apiCredentialId:credentialId,credentialVersion:1,publicProfile:"transport",upstreamModel:"glm-5.3"});
    await db.insert(schema.agentTasks).values({id:localTaskId,operationId,createMarker:binding,title:"legacy transport acceptance",providerState:"queued",providerRuntime:{dashboardManaged:{revision:1,model:"glm-5.3",effort:"high",intentId,sessionId,commands:[],mutations:{},files:[]}}});
    const {dashboardAgentRuntimeStore} = await import('./providers/dashboard-agent-runtime-store');
    const identity = {provider:"zhipu" as const,accountUserId:101,credentialId,credentialVersion:1,enterpriseProjectId:legacy.id,enterpriseProjectLegacyDefault:true};
    expect((await dashboardAgentRuntimeStore.reserve({identity,intentId,model:"glm-5.3",effort:"high"})).localTaskId).toBe(localTaskId);
    expect(await dashboardAgentRuntimeStore.findBySession({...identity,enterpriseProjectId:projectB.id,enterpriseProjectLegacyDefault:false},sessionId)).toBeNull();
    expect(await dashboardAgentRuntimeStore.findBySession({...identity,enterpriseProjectId:null,enterpriseProjectLegacyDefault:false},sessionId)).toBeNull();
    // Account deletion clears every project, even when invoked under one project.
    const freshActor = {...actor,id:fresh!.id,username:newUsername};
    const freshProject = await service.createEnterpriseProject(freshActor,{name:"待删除甲",clientRequestId:randomUUID()});
    await service.createEnterpriseProject(freshActor,{name:"待删除乙",clientRequestId:randomUUID()});
    const {permanentlyDeleteManagedUserRows} = await import('./auth-service');
    await runWithEnterpriseProjectScope({...scope,ownerUserId:fresh!.id,actorUserId:103,enterpriseProjectId:freshProject.id}, () => db.transaction(tx => permanentlyDeleteManagedUserRows(tx,fresh!.id)));
    expect(await db.select().from(schema.users).where(eq(schema.users.id,fresh!.id))).toHaveLength(0);
    expect(await db.select().from(schema.enterpriseProjects).where(eq(schema.enterpriseProjects.ownerUserId,fresh!.id))).toHaveLength(0);

  },30000);
});
