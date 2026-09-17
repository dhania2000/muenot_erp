// No-op stand-in for the `server-only` package under Vitest. The real package
// throws if imported into a client bundle; in tests we only run the pure logic
// of the modules that import it.
export {}
