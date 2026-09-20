"use client"
import { useEffect, useState } from "react"
import { EVENT_CATALOG, type EventType } from "@/lib/events/model"
import { AutomationTabs } from "./automation-tabs"
const input="w-full rounded border bg-background px-3 py-2"
export function BusinessEventMonitor() {
  const [data,setData]=useState<any>({events:[],subscriptions:[],deliveries:[],history:[]})
  const [error,setError]=useState(""),[busy,setBusy]=useState(false)
  const [name,setName]=useState(""),[eventType,setEventType]=useState<EventType>("deal.won")
  const [handler,setHandler]=useState("notice"),[target,setTarget]=useState("")
  async function load(){const response=await fetch("/api/admin/event-bus");const body=await response.json();if(!response.ok)throw new Error(body.error);setData(body)}
  useEffect(()=>{load().catch(e=>setError(e.message));const timer=setInterval(()=>load().catch(e=>setError(e.message)),15000);return()=>clearInterval(timer)},[])
  async function send(body:unknown){setBusy(true);setError("");try{const response=await fetch("/api/admin/event-bus",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error);await load()}catch(e){setError(e instanceof Error?e.message:"Request failed")}finally{setBusy(false)}}
  return <section className="space-y-5 p-6">
    <h1 className="text-2xl font-semibold">Business event bus</h1><AutomationTabs/>
    <p>Committed business changes → saved events → independent subscriber deliveries. Latest 100 events and 200 deliveries. Existing records are not backfilled.</p>
    <p role="status" className="text-destructive">{error}</p>
    <details className="border rounded p-3"><summary>Event inventory</summary>{Object.entries(EVENT_CATALOG).map(([type,info])=><p key={type}>{type} · {info.module} · {info.publisher==="active"?"Publisher connected":"Publisher not yet connected"}</p>)}</details>
    <section className="border rounded p-4 space-y-3"><h2 className="text-xl">Add subscriber</h2>
      <label className="block">Name<input className={input} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label className="block">Event<select className={input} value={eventType} onChange={e=>{setEventType(e.target.value as EventType);setHandler("notice");setTarget("")}}>{Object.entries(EVENT_CATALOG).filter(([,v])=>v.publisher==="active").map(([type])=><option key={type}>{type}</option>)}</select></label>
      <label className="block">Subscriber action<select className={input} value={handler} onChange={e=>{setHandler(e.target.value);setTarget("")}}><option value="notice">In-app notification</option>{eventType==="deal.won" && <option value="workflow">Start Sales workflow</option>}</select></label>
      <label className="block">{handler==="notice"?"Recipient user ID":"Existing manual Sales workflow ID"}<input className={input} type="number" min="1" value={target} onChange={e=>setTarget(e.target.value)}/></label>
      <p className="text-sm">Workflow definitions are snapshotted when subscribing. Disabling a subscriber stops future events only; queued deliveries continue. For workflow edits, disable the old subscriber and create a new one.</p>
      <button className="rounded bg-primary px-4 py-2 text-primary-foreground" disabled={busy} onClick={()=>send({operation:"subscribe",subscription:{name,eventType,handler,...(handler==="notice"?{userId:Number(target)}:{workflowId:Number(target)})}})}>Add subscriber</button>
    </section>
    <section><h2 className="text-xl">Subscribers</h2>{data.subscriptions.map((s:any)=><div className="flex gap-3 border-b py-2" key={s.id}><span>#{s.id} {s.name} · {s.event_type} · {s.enabled?"Enabled":"Disabled"}</span><button disabled={busy} onClick={()=>send({operation:"toggle",id:Number(s.id),enabled:!s.enabled})}>{s.enabled?"Disable":"Enable"}</button></div>)}</section>
    <section><h2 className="text-xl">Business events</h2>{data.events.map((e:any)=><p className="border-b py-2" key={e.id}>Event #{e.id} · {e.event_type} · Record #{e.entity_id} · {e.subscribers} deliveries · {e.pending||0} pending · {e.failed||0} failed · {e.created_at}</p>)}</section>
    <section><h2 className="text-xl">Subscriber deliveries</h2><div className="overflow-auto"><table className="w-full text-left"><thead><tr>{["Delivery","Event","Subscriber","Status","Attempts","Result ID","Action"].map(h=><th className="p-2" key={h}>{h}</th>)}</tr></thead><tbody>{data.deliveries.map((d:any)=><tr className="border-t" key={d.id}><td>{d.id}</td><td>{d.event_id}</td><td>{d.subscriber_id}</td><td>{d.status}{d.error_code?": "+d.error_code:""}</td><td>{d.attempts}</td><td>{d.result_id??"—"}</td><td>{d.status==="failed" && <button disabled={busy} onClick={()=>send({operation:"retry",id:Number(d.id),attempt:Number(d.attempts)})}>Retry once</button>}</td></tr>)}</tbody></table></div></section>
    <details className="border rounded p-3"><summary>Delivery history</summary>{data.history.map((h:any,i:number)=><p key={i}>Delivery #{h.delivery_id} · {h.action} · Attempt {h.attempt} · {h.created_at}</p>)}</details>
  </section>
}
