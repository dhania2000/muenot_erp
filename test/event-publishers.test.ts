import { beforeEach, describe, expect, it, vi } from "vitest"
const mock=vi.hoisted(()=>({sql:vi.fn(),query:vi.fn(),publish:vi.fn(),commit:vi.fn(),rollback:vi.fn()}))
vi.mock("@/lib/db",()=>({query:mock.query,withTransaction:async(fn:any)=>{try{const value=await fn({query:mock.sql});mock.commit();return value}catch(e){mock.rollback();throw e}}}))
vi.mock("@/lib/events/schema",()=>({ensureEventSchema:async()=>{}}))
vi.mock("@/lib/events/bus",()=>({publishEvent:mock.publish}))
vi.mock("@/lib/tenant-scope",()=>({currentTenantId:()=>7,scopedWhere:()=>({where:"WHERE tenant_id=?",params:[7]}),tenantUpdate:vi.fn(),CrossTenantAccessError:Error}))
import { setUploadStatus } from "@/lib/storage/file-metadata"
beforeEach(()=>{
  vi.clearAllMocks();mock.query.mockResolvedValue([])
  mock.publish.mockResolvedValue(10)
  mock.sql.mockImplementation(async(sql:string)=>sql.startsWith("SELECT")?[[{id:20}]]:[{affectedRows:1}])
})
describe("file upload publisher transaction",()=>{
  it("publishes completion within the metadata transaction",async()=>{
    await setUploadStatus(20,"completed")
    expect(mock.sql).toHaveBeenCalledWith(expect.stringContaining("WHERE tenant_id=? AND id=? FOR UPDATE"),[7,20])
    expect(mock.publish).toHaveBeenCalledWith({query:mock.sql},{tenantId:7,type:"file.uploaded",entityId:20,key:"file:20:uploaded",actorId:null})
    expect(mock.commit).toHaveBeenCalledTimes(1)
  })
  it("does not publish incomplete uploads or foreign records",async()=>{
    await setUploadStatus(20,"pending");expect(mock.publish).not.toHaveBeenCalled()
    mock.sql.mockResolvedValue([[]])
    expect(await setUploadStatus(99,"completed")).toBe(false)
    expect(mock.publish).not.toHaveBeenCalled()
  })
  it("propagates publisher failure so metadata transaction rolls back",async()=>{
    mock.publish.mockRejectedValue(new Error("outbox unavailable"))
    await expect(setUploadStatus(20,"completed")).rejects.toThrow("outbox unavailable")
    expect(mock.rollback).toHaveBeenCalledTimes(1);expect(mock.commit).not.toHaveBeenCalled()
  })
})
