"use client"

import React from "react"

type Props = {
  children: React.ReactNode
  /** Rendered instead of children when a descendant throws. */
  fallback?: React.ReactNode
}

type State = { hasError: boolean }

/**
 * Contains render/runtime errors from a subtree so a single misbehaving widget
 * (e.g. a header control) cannot crash the whole page. Without a boundary, any
 * thrown error bubbles to Next.js's bare "This page couldn't load" screen.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    console.log("[v0] ErrorBoundary caught:", error)
  }

  render() {
    if (this.state.hasError) return this.props.fallback ?? null
    return this.props.children
  }
}
