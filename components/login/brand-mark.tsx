"use client"

import Image from "next/image"
import { useState } from "react"

const BUNDLED_LOGO = "/muenot-logo-transparent.png"

export function BrandMark({
  logo,
  brandName,
  className,
}: {
  logo?: string
  brandName: string
  className?: string
}) {
  const [failed, setFailed] = useState(false)

  // Remote/company logo can be any host, so use a plain <img>; fall back to the
  // bundled mark if it is missing or fails to load.
  if (logo && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo || "/placeholder.svg"} alt={brandName} className={className} onError={() => setFailed(true)} />
  }

  return <Image src={BUNDLED_LOGO || "/placeholder.svg"} alt={brandName} width={132} height={30} className={className} priority />
}
