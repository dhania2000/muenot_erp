import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

const configs: Record<string,{table:string; id:string; fields:string[]}> = {
  departments:{table:"hr_departments",id:"department_id",fields:["department_id","department_name","parent_department_id","head_employee_id","description","status"]},
  designations:{table:"hr_designations",id:"designation_id",fields:["designation_id","designation_name","parent_designation_id","level_name","description","status"]},
  promotions:{table:"hr_promotions",id:"promotion_id",fields:["employee_id","effective_date","old_designation_id","new_designation_id","old_department_id","new_department_id","old_grade","new_grade","old_salary","new_salary","reason","approved_by","approver_name","status"]},
  awards:{table:"hr_awards",id:"award_id",fields:["employee_id","award_name","award_date","given_by","description","badge_url","status"]},
  appreciations:{table:"hr_appreciations",id:"appreciation_id",fields:["employee_id","title","message","given_by","appreciation_date","category","status"]},
  "passport-visa":{table:"hr_passport_visa",id:"record_id",fields:["employee_id","passport_number","passport_issue_date","passport_expiry_date","visa_type","visa_number","visa_issue_date","visa_expiry_date","country","status","passport_path","visa_path","remarks"]},
  holidays:{table:"hr_holidays",id:"holiday_id",fields:["holiday_name","holiday_date","holiday_type","applicable_department_id","applicable_state_ut","optional","description","status","year"]},
}
export async function GET(req:NextRequest){const s=await getSession();if(!s)return NextResponse.json({error:"Unauthorized"},{status:401});const c=configs[req.nextUrl.searchParams.get("kind")||""];if(!c)return NextResponse.json({error:"Invalid kind"},{status:400});return NextResponse.json({rows:await query(`SELECT * FROM ${c.table} ORDER BY ${c.id} DESC`)})}
export async function POST(req:NextRequest){const s=await getSession();if(!s)return NextResponse.json({error:"Unauthorized"},{status:401});const c=configs[(await req.clone().json()).kind||""];if(!c)return NextResponse.json({error:"Invalid kind"},{status:400});const body=await req.json();const fields=c.fields.filter(f=>body[f]!==undefined);if(!fields.length)return NextResponse.json({error:"No fields"},{status:400});await query(`INSERT INTO ${c.table} (${fields.join(",")}) VALUES (${fields.map(()=>"?").join(",")})`,fields.map(f=>body[f]));return NextResponse.json({ok:true},{status:201})}
export async function PATCH(req:NextRequest){const s=await getSession();if(!s)return NextResponse.json({error:"Unauthorized"},{status:401});const body=await req.json();const c=configs[body.kind||""];if(!c||!body.id)return NextResponse.json({error:"Invalid request"},{status:400});const fields=c.fields.filter(f=>f!==c.id&&body[f]!==undefined);await query(`UPDATE ${c.table} SET ${fields.map(f=>`${f}=?`).join(",")} WHERE ${c.id}=?`,[...fields.map(f=>body[f]),body.id]);return NextResponse.json({ok:true})}
