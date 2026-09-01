import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

const defaults = [
  ["company.business_name","Company","Business Name","Name shown across the workspace","Muenot Business Team","text",0],
  ["company.address","Company","Business Address","Registered business address","","text",0],
  ["app.currency","App Settings","Currency","Default currency code","INR","select",0],
  ["notifications.email_enabled","Notification Settings","Email Notifications","Enable application email notifications","true","boolean",0],
  ["finance.tax_enabled","Finance Settings","Tax Enabled","Enable tax calculations in Finance","true","boolean",0],
  ["attendance.grace_minutes","Attendance Settings","Grace Minutes","Late attendance grace period","15","number",0],
  ["leaves.require_document","Leaves Settings","Require Leave Document","Require attachments for document-required leave types","true","boolean",0],
  ["security.session_timeout","Security Settings","Session Timeout","Session timeout in minutes","480","number",0],
  ["storage.provider","Storage Settings","Storage Provider","Storage backend used by uploads","Vercel Blob","text",0],
  ["theme.mode","Theme Settings","Theme Mode","Default theme for the workspace","dark","select",0],
  ["api.rest_enabled","REST API Setting","REST API Enabled","Allow REST API access","false","boolean",1],
]
async function guard(){ const s=await getSession(); return s?.role === "admin" ? s : null }
export async function GET(){ if(!await guard()) return NextResponse.json({error:"Forbidden"},{status:403}); const rows=await query<any[]>("SELECT * FROM admin_settings ORDER BY category,label"); if(!rows.length) for(const d of defaults) await query("INSERT IGNORE INTO admin_settings (setting_key,category,label,description,value,value_type,is_secret) VALUES (?,?,?,?,?,?,?)",d); const result=rows.length?rows:await query<any[]>("SELECT * FROM admin_settings ORDER BY category,label"); return NextResponse.json(result.map((r:any)=>({...r,value:r.is_secret?"••••••••":r.value}))) }
export async function POST(req:Request){ const s=await guard(); if(!s)return NextResponse.json({error:"Forbidden"},{status:403}); const b=await req.json(); if(!b.setting_key||typeof b.value !== "string")return NextResponse.json({error:"Invalid setting"},{status:400}); await query("UPDATE admin_settings SET value=?,updated_by=? WHERE setting_key=?",[b.value,s.userId,b.setting_key]); return NextResponse.json({ok:true}) }
