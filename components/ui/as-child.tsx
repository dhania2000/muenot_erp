import * as React from "react"

/**
 * Radix→Base UI compatibility shim.
 *
 * Radix primitives accept `asChild` to merge a component's behavior onto its
 * single child element. Base UI expresses the same idea with a `render` prop.
 * This translates `asChild` + a single valid child into `render`, and otherwise
 * passes `children` through unchanged.
 */
export function asChildProps(
  asChild: boolean | undefined,
  children: React.ReactNode,
): { render: React.ReactElement } | { children: React.ReactNode } {
  if (asChild && React.isValidElement(children)) {
    return { render: children }
  }
  return { children }
}
