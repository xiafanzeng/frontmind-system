import { describe,expect,it } from "vitest";
import { AiBillingError, AiBillingPausedError } from "./ai-billing-service";
import { aiBillingHttpFailure } from "./ai-billing-http";

describe("AI financial HTTP contract",()=>{
  it("returns actionable 402 without automatic retry or reset for an unfunded command",()=>{
    expect(aiBillingHttpFailure(new AiBillingError("AI_BALANCE_INSUFFICIENT"))).toMatchObject({status:402,error:{code:"AI_BALANCE_INSUFFICIENT",retryable:false,resetRequired:false,dispatchSettled:true,accountUrl:"/account",recoveryAction:"top_up"}});
  });
  it("does not claim an interrupted command was never executed",()=>{
    const failure=aiBillingHttpFailure(new AiBillingPausedError({reason:"balance",stage:"after_send",sessionId:"session",commandKey:"initial",pausedAt:new Date().toISOString()}));
    expect(failure?.status).toBe(402);expect(failure?.error).not.toHaveProperty("dispatchSettled");
  });
  it("keeps pending cost and resume ambiguity separate from a recharge refusal",()=>{
    expect(aiBillingHttpFailure(new AiBillingError("AI_COST_PENDING"))).toMatchObject({status:503,error:{retryable:false,recoveryAction:"check_status"}});
    expect(aiBillingHttpFailure(new AiBillingError("AI_RESUME_PENDING"))).toMatchObject({status:409,error:{retryable:false}});
    expect(aiBillingHttpFailure(new Error("unrelated"))).toBeNull();
  });
});
