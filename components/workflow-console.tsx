"use client"
import { useEffect, useState } from "react"
import { FIELDS, type Action, type Workflow } from "@/lib/workflows/model"

const initial: Workflow = {name:"",module:"sales_leads",trigger:"manual",conditions:[],actions:[]}
const control = "rounded border bg-background px-3 py-2 w-full"
const defaults: Record<Action["type"], Action> = {
  notify:{type:"notify",userId:0,message:""}, approval:{type:"approval",userId:0,message:""},
  delay:{type:"delay",seconds:60}, schedule:{type:"schedule",at:""}, webhook:{type:"webhook",target:""},
  update:{type:"update",field:"priority",value:"High"}, assign:{type:"assign",userId:0},
  create:{type:"create",title:"",description:"",userId:0},
}
export function WorkflowConsole({initialRecordId=""}:{initialRecordId?:string}) {
  const [draft,setDraft] = useState<Workflow>(initial)
  const [data,setData] = useState<any>({definitions:[],runs:[],notices:[],tasks:[],events:[]})
  const [message,setMessage] = useState(""), [busy,setBusy] = useState(false)
  const [workflowId,setWorkflowId] = useState(""), [recordId,setRecordId] = useState(initialRecordId), [at,setAt] = useState("")
  const [requestKey,setRequestKey] = useState("")
  async function load() { const r = await fetch("/api/admin/workflows"); const b = await r.json(); if (!r.ok) throw new Error(b.error); setData(b) }
  useEffect(() => { load().catch(e=>setMessage(e.message)); const t=setInterval(()=>load().catch(()=>{}),15000); return ()=>clearInterval(t) },[])
  async function send(body: unknown) {
    setBusy(true); setMessage("")
    try { const r=await fetch("/api/admin/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}); const b=await r.json(); if(!r.ok) throw new Error(b.error); setMessage(`Saved${b.id ? ` (#${b.id})` : ""}`); await load(); return true }
    catch(e) { setMessage(e instanceof Error ? e.message : "Request failed"); return false } finally { setBusy(false) }
  }
  function updateAction(i:number, patch: Record<string,unknown>) { setDraft({...draft,actions:draft.actions.map((a,n)=>n===i ? {...a,...patch} as Action : a)}) }
  const chosen = data.definitions.find((d:any)=>String(d.id)===workflowId)
  const definition = chosen ? (typeof chosen.definition === "string" ? JSON.parse(chosen.definition) : chosen.definition) : null
  return <main className="space-y-6 max-w-5xl">
    <h1 className="text-2xl font-semibold">Workflow engine</h1>
    <p>Create reusable workflows for Sales leads and cross-module workflow tasks. Actions run in order through the central scheduler. Dates are UTC; approvals require another designated tenant admin.</p>
    <p role="status" className="text-primary">{message}</p>
    <section className="border rounded p-4 space-y-4"><h2 className="text-xl">Create workflow</h2>
      <label className="block">Name<input className={control} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label className="block">Record type<select className={control} value={draft.module} onChange={e=>setDraft({...draft,module:e.target.value as Workflow["module"],conditions:[],actions:[]})}><option value="sales_leads">Sales lead</option><option value="workflow_tasks">Workflow task</option></select></label>
      <label className="block">Trigger<select className={control} value={draft.trigger} onChange={e=>setDraft({...draft,trigger:e.target.value as Workflow["trigger"]})}><option value="manual">Run on request</option><option value="scheduled">Run at scheduled time</option></select></label>
      <h3>Conditions (all must match when execution begins)</h3>
      {draft.conditions.map((r,i)=><div className="flex gap-2" key={i}>
        <select aria-label="Condition field" className={control} value={r.field} onChange={e=>setDraft({...draft,conditions:draft.conditions.map((v,n)=>i===n ? {...v,field:e.target.value}:v)})}>{FIELDS[draft.module].map(f=><option key={f}>{f}</option>)}</select>
        <select aria-label="Comparison" className={control} value={r.op} onChange={e=>setDraft({...draft,conditions:draft.conditions.map((v,n)=>i===n ? {...v,op:e.target.value as typeof r.op}:v)})}><option value="eq">Equals</option><option value="neq">Does not equal</option><option value="contains">Contains</option></select>
        <input aria-label="Condition value" className={control} value={r.value} onChange={e=>setDraft({...draft,conditions:draft.conditions.map((v,n)=>i===n ? {...v,value:e.target.value}:v)})}/>
        <button onClick={()=>setDraft({...draft,conditions:draft.conditions.filter((_,n)=>n!==i)})}>Remove</button>
      </div>)}
      <button disabled={draft.conditions.length>=20} onClick={()=>setDraft({...draft,conditions:[...draft.conditions,{field:FIELDS[draft.module][0],op:"eq",value:""}]})}>+ Condition</button>
      <h3>Actions</h3>
      {draft.actions.map((a,i)=><fieldset className="border rounded p-3 space-y-2" key={i}><legend>Step {i+1}: {a.type}</legend>
        {"userId" in a && <label className="block">{a.type==="approval" ? "Approver" : "Recipient / assignee"} user ID<input type="number" min="1" className={control} value={a.userId||""} onChange={e=>updateAction(i,{userId:Number(e.target.value)})}/></label>}
        {"message" in a && <label className="block">Message<input className={control} value={a.message} onChange={e=>updateAction(i,{message:e.target.value})}/></label>}
        {a.type==="create" && <><label className="block">New workflow task title<input className={control} value={a.title} onChange={e=>updateAction(i,{title:e.target.value})}/></label><label className="block">Description<textarea className={control} value={a.description} onChange={e=>updateAction(i,{description:e.target.value})}/></label></>}
        {a.type==="delay" && <label className="block">Delay in seconds<input type="number" min="1" max="2592000" className={control} value={a.seconds} onChange={e=>updateAction(i,{seconds:Number(e.target.value)})}/></label>}
        {a.type==="schedule" && <label className="block">Resume at (UTC, e.g. 2026-10-01T09:00:00Z)<input className={control} value={a.at} onChange={e=>updateAction(i,{at:e.target.value})}/></label>}
        {a.type==="webhook" && <label className="block">Configured destination name (ask platform admin)<input className={control} value={a.target} onChange={e=>updateAction(i,{target:e.target.value})}/></label>}
        {a.type==="update" && <><select aria-label="Update field" className={control} value={a.field} onChange={e=>updateAction(i,{field:e.target.value,value:e.target.value==="priority" ? "High" : ""})}><option value="priority">Priority</option>{draft.module==="workflow_tasks" && <option value="description">Description</option>}</select>{a.field==="priority" ? <select aria-label="Priority" className={control} value={a.value} onChange={e=>updateAction(i,{value:e.target.value})}>{["Low","Medium","High","Urgent"].map(v=><option key={v}>{v}</option>)}</select> : <textarea aria-label="Description" className={control} value={a.value} onChange={e=>updateAction(i,{value:e.target.value})}/>}</>}
        <button onClick={()=>setDraft({...draft,actions:draft.actions.filter((_,n)=>n!==i)})}>Remove step</button>
      </fieldset>)}
      <select aria-label="Add action" className={control} value="" disabled={draft.actions.length>=30} onChange={e=>setDraft({...draft,actions:[...draft.actions,{...defaults[e.target.value as Action["type"]]}]})}><option value="" disabled>Add an action…</option>{Object.keys(defaults).map(k=><option key={k}>{k}</option>)}</select>
      <button className="rounded bg-primary text-primary-foreground px-4 py-2" disabled={busy} onClick={()=>send({operation:"create",definition:draft})}>Save workflow</button>
    </section>
    <section className="border rounded p-4 space-y-3"><h2 className="text-xl">Run / schedule workflow</h2>
      <label className="block">Workflow<select className={control} value={workflowId} onChange={e=>{setWorkflowId(e.target.value);setRequestKey("")}}><option value="">Choose…</option>{data.definitions.map((d:any)=><option key={d.id} value={d.id}>#{d.id} {d.name}</option>)}</select></label>
      <label className="block">Existing {definition?.module==="workflow_tasks" ? "workflow task" : "Sales lead"} ID<input type="number" min="1" className={control} value={recordId} onChange={e=>{setRecordId(e.target.value);setRequestKey("")}}/></label>
      {definition?.trigger==="scheduled" && <label className="block">Run at (ISO UTC date)<input className={control} value={at} placeholder="2026-10-01T09:00:00Z" onChange={e=>{setAt(e.target.value);setRequestKey("")}}/></label>}
      <button disabled={busy||!workflowId||!recordId} onClick={async()=>{const key=requestKey||crypto.randomUUID();setRequestKey(key); if(await send({operation:"start",workflowId:Number(workflowId),recordId:Number(recordId),requestKey:key,...(definition?.trigger==="scheduled" ? {at}: {})})) setRequestKey("")}}>Start workflow</button>
    </section>
    <section><h2 className="text-xl">Recent runs</h2><div className="overflow-auto"><table className="w-full text-left"><thead><tr>{["Run","Workflow","Record","Status","Step","Details","Approval"].map(h=><th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{data.runs.map((r:any)=><tr className="border-t" key={r.id}><td className="p-2">{r.id}</td><td>{r.workflow_id}</td><td>{r.record_id}</td><td>{r.status}</td><td>{r.cursor+1}</td><td>{r.error_code||r.available_at}</td><td>{r.status==="approval" && <><button disabled={busy} onClick={()=>send({operation:"decide",runId:Number(r.id),approve:true})}>Approve</button>{" / "}<button disabled={busy} onClick={()=>send({operation:"decide",runId:Number(r.id),approve:false})}>Reject</button></>}</td></tr>)}</tbody></table></div></section>
    <section><h2 className="text-xl">Run definitions & controls</h2>{data.runs.map((r:any)=><details className="border rounded p-3 my-2" key={r.id}><summary>Run #{r.id} · Record #{r.record_id} · {r.status}</summary><p>Review this immutable definition before approving. Cancelling stops remaining actions; it does not undo completed actions.</p><pre className="overflow-auto text-xs my-3">{JSON.stringify(typeof r.snapshot==="string" ? JSON.parse(r.snapshot) : r.snapshot,null,2)}</pre>{["queued","waiting","approval"].includes(r.status) && <button disabled={busy} onClick={()=>send({operation:"cancel",runId:Number(r.id)})}>Cancel remaining actions</button>}</details>)}</section>
    <section><h2 className="text-xl">Your workflow notifications</h2>{data.notices.map((n:any)=><p key={n.id}>Run #{n.run_id}: {n.message}</p>)}</section>
    <section><h2 className="text-xl">Created workflow tasks</h2>{data.tasks.map((t:any)=><p key={t.id}>#{t.id} {t.title} · {t.priority} · {t.status} · User #{t.assigned_to} · Source run #{t.source_run_id}</p>)}</section>
    <section><h2 className="text-xl">Recent execution history</h2>{data.events.map((e:any,i:number)=><p key={i}>Run #{e.run_id}, step {e.step+1}: {e.event_type} · {e.created_at}</p>)}</section>
  </main>
}
