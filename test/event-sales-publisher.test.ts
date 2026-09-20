import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({sql:vi.fn(),query:vi.fn(),publish:vi.fn(),begin:vi.fn(),commit:vi.fn(),rollback:vi.fn(),release:vi.fn()}))
vi.mock("@/lib/db",()=>({query:mock.query,pool:{getConnection:async()=>({query:mock.sql,beginTransaction:mock.begin,commit:mock.commit,rollback:mock.rollback,release:mock.release})}}))
vi.mock("@/lib/tenant-context",()=>({requireCurrentTenantId:()=>7}))
vi.mock("@/lib/events/schema",()=>({ensureEventSchema:async()=>{}}))
vi.mock("@/lib/events/bus",()=>({publishEvent:mock.publish}))
import { markLeadWon } from "@/lib/sales/lead-lifecycle"
let source:any
beforeEach(()=>{
  vi.clearAllMocks();mock.query.mockResolvedValue([]);mock.publish.mockResolvedValue(10)
  source={id:20,row_version:3,status:"New",lead_status:"Open",assigned_to:null,estimated_value:100,lead_code:"MLD-20",company_name:"Example"}
  mock.sql.mockImplementation(async(sql:string)=>sql.includes("SELECT * FROM sales_leads")?[[source]]:[{affectedRows:1}])
})
describe("deal won publisher",()=>{
  it("checks source tenant and publishes before commit",async()=>{
    await markLeadWon(20,{},2)
    expect(mock.sql).toHaveBeenCalledWith("SELECT * FROM sales_leads WHERE tenant_id = ? AND id = ? FOR UPDATE",[7,20])
    expect(mock.publish).toHaveBeenCalledWith(expect.objectContaining({query:mock.sql}),{tenantId:7,type:"deal.won",entityId:20,key:"lead:20:won:4",actorId:2})
    expect(mock.publish.mock.invocationCallOrder[0]).toBeLessThan(mock.commit.mock.invocationCallOrder[0])
  })
  it("does not emit another win for an already-won lead",async()=>{
    source.lead_status="Won"
    await markLeadWon(20,{},2)
    expect(mock.publish).not.toHaveBeenCalled()
  })
  it("rejects missing or cross-tenant sources",async()=>{
    mock.sql.mockResolvedValue([[]])
    await expect(markLeadWon(99,{},2)).rejects.toThrow("Lead not found")
    expect(mock.publish).not.toHaveBeenCalled()
  })
  it("rolls back the business transaction if outbox publication fails",async()=>{
    mock.publish.mockRejectedValue(new Error("outbox failed"))
    await expect(markLeadWon(20,{},2)).rejects.toThrow("outbox failed")
    expect(mock.rollback).toHaveBeenCalledTimes(1);expect(mock.commit).not.toHaveBeenCalled()
  })
})
