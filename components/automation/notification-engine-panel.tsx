"use client"
import { useEffect, useState } from "react"
import { CHANNELS } from "@/lib/notification-engine/model"
import { NotificationPreferences } from "@/components/notification-preferences"
import { AutomationTabs } from "./automation-tabs"
const field="border rounded bg-background px-3 py-2 w-full"
export function NotificationEnginePanel(){
  const [data,setData]=useState<any>({templates:[],deliveries:[],history:[]}),[message,setMessage]=useState(""),[busy,setBusy]=useState(false)
  const [name,setName]=useState(""),[title,setTitle]=useState(""),[body,setBody]=useState("")
  const [template,setTemplate]=useState(""),[user,setUser]=useState(""),[channel,setChannel]=useState("in_app"),[priority,setPriority]=useState(5),[at,setAt]=useState(""),[variables,setVariables]=useState<Record<string,string>>({}),[key,setKey]=useState("")
  async function load(){const r=await fetch("/api/admin/notification-engine");const b=await r.json();if(!r.ok)throw new Error(b.error);setData(b)}
  useEffect(()=>{load().catch(e=>setMessage(e.message));const t=setInterval(()=>load().catch(()=>{}),15000);return()=>clearInterval(t)},[])
  async function send(b:unknown){setBusy(true);try{const r=await fetch("/api/admin/notification-engine",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});const v=await r.json();if(!r.ok)throw new Error(v.error);setMessage("Saved"+(v.id?" #"+v.id:""));await load();return true}catch(e){setMessage(e instanceof Error?e.message:"Request failed");return false}finally{setBusy(false)}}
  const chosen=data.templates.find((t:any)=>String(t.id)===template)
  const names=[...new Set<string>(Array.from(((chosen?.title??"")+" "+(chosen?.body??"")).matchAll(/{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g),(m:any)=>m[1]))]
  function change(){setKey("")}
  return <section className="p-6 space-y-5"><h1 className="text-2xl font-semibold">Notification engine</h1><AutomationTabs/><p role="status">{message}</p>
    <section className="border rounded p-4 space-y-2"><h2 className="text-xl">Create template</h2><p>Plain text with variables such as {"{{name}}"}. Saved templates are immutable; create a new one for changes.</p><label className="block">Name<input className={field} value={name} onChange={e=>setName(e.target.value)}/></label><label className="block">Title<input className={field} value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="block">Body<textarea className={field} value={body} onChange={e=>setBody(e.target.value)}/></label><button disabled={busy} onClick={()=>send({operation:"template",name,title,body})}>Save template</button></section>
    <section className="border rounded p-4 space-y-2"><h2 className="text-xl">Send / schedule notification</h2><label className="block">Template<select className={field} value={template} onChange={e=>{setTemplate(e.target.value);setVariables({});change()}}><option value="">Select…</option>{data.templates.map((t:any)=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="block">Recipient user ID<input className={field} type="number" min="1" value={user} onChange={e=>{setUser(e.target.value);change()}}/></label>
      <label className="block">Channel<select className={field} value={channel} onChange={e=>{setChannel(e.target.value);change()}}>{CHANNELS.map(c=><option key={c}>{c}</option>)}</select></label>
      <label className="block">Priority<select className={field} value={priority} onChange={e=>{setPriority(Number(e.target.value));change()}}><option value={0}>Low</option><option value={5}>Normal</option><option value={10}>High</option></select></label>
      <label className="block">Scheduled UTC time (blank = now)<input className={field} placeholder="2026-10-01T09:00:00Z" value={at} onChange={e=>{setAt(e.target.value);change()}}/></label>
      {names.map(n=><label className="block" key={n}>{n}<input className={field} value={variables[n]??""} onChange={e=>{setVariables({...variables,[n]:e.target.value});change()}}/></label>)}
      <button disabled={busy||!template||!user} onClick={async()=>{const requestKey=key||crypto.randomUUID();setKey(requestKey);if(await send({operation:"send",templateId:Number(template),userId:Number(user),channel,priority,variables,key:requestKey,...(at?{at}:{})}))setKey("")}}>Queue notification</button>
    </section><NotificationPreferences/>
    <section><h2 className="text-xl">Recent deliveries</h2><p>Accepted = provider accepted the request, not confirmed device delivery. Uncertain sends are never automatically retried. Missing providers stay blocked.</p><div className="overflow-auto"><table className="w-full text-left"><thead><tr>{["ID","User","Channel","Priority","Status","Attempts","Due","Action"].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{data.deliveries.map((d:any)=><tr className="border-t" key={d.id}><td>{d.id}</td><td>{d.user_id}</td><td>{d.channel}</td><td>{d.priority}</td><td>{d.status} {d.error_code}</td><td>{d.attempts}</td><td>{d.available_at}</td><td>{["failed","blocked"].includes(d.status)&&<button disabled={busy} onClick={()=>send({operation:"retry",id:Number(d.id),attempt:Number(d.attempts)})}>Retry</button>}</td></tr>)}</tbody></table></div></section>
    <details><summary>Delivery history</summary>{data.history.map((h:any,i:number)=><p key={i}>#{h.delivery_id} · {h.status} · Attempt {h.attempt} · {h.created_at}</p>)}</details>
  </section>
}
