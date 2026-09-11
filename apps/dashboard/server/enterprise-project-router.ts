import { createEnterpriseMonitoringProject, getEnterpriseMonitoringProgress } from "./enterprise-project-monitoring";
import { deleteEnterpriseProject } from "./enterprise-project-deletion";
import { z } from "zod";
import { protectedProcedure, router } from "./_core/trpc";
import { toTrpcError } from "./auth-router";
import { createEnterpriseProject, listEnterpriseProjects, renameEnterpriseProject } from "./enterprise-project-service";

export const enterpriseProjectRouter = router({
  delete: protectedProcedure.input(z.object({ enterpriseProjectId: z.string().uuid(), expectedRevision: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    try { return await deleteEnterpriseProject(ctx.user, input); } catch (error) { throw toTrpcError(error); }
  }),
  createMonitoringProject: protectedProcedure.input(z.object({ enterpriseProjectId: z.string().uuid(), name: z.string().trim().min(1).max(120), questionIds: z.array(z.string().uuid()).max(500), customQuestions: z.array(z.string().trim().min(1).max(4000)).max(50).optional(), clientRequestId: z.string().uuid() }).refine(input => input.questionIds.length > 0 || (input.customQuestions?.length ?? 0) > 0, { message: "请选择或输入至少一个要监控的问题" })).mutation(async ({ ctx, input }) => { try { return await createEnterpriseMonitoringProject(ctx.user, input); } catch (error) { throw toTrpcError(error); } }),
  monitoringProgress: protectedProcedure.input(z.object({ enterpriseProjectId: z.string().uuid() })).query(async ({ ctx, input }) => { try { return await getEnterpriseMonitoringProgress(ctx.user, input.enterpriseProjectId); } catch (error) { throw toTrpcError(error); } }),
  list: protectedProcedure.input(z.object({ ownerUserId: z.number().int().positive().optional() }).optional()).query(async ({ ctx, input }) => {
    try { return await listEnterpriseProjects(ctx.user, input?.ownerUserId); } catch (error) { throw toTrpcError(error); }
  }),
  create: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(120), clientRequestId: z.string().uuid(), ownerUserId: z.number().int().positive().optional() })).mutation(async ({ ctx, input }) => {
    try { return await createEnterpriseProject(ctx.user, input); } catch (error) { throw toTrpcError(error); }
  }),
  rename: protectedProcedure.input(z.object({ enterpriseProjectId: z.string().uuid(), name: z.string().trim().min(1).max(120), expectedRevision: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    try { return await renameEnterpriseProject(ctx.user, input); } catch (error) { throw toTrpcError(error); }
  }),
});
