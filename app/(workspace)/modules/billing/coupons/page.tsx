import { billingGuard } from "@/lib/billing-guard"
import { CouponConsole } from "@/components/billing/coupon-console"

export default async function Page() {
  await billingGuard()
  return <CouponConsole />
}
