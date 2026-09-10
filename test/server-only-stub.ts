// `server-only` throws when imported outside a React Server Component build.
// That guard is exactly what we want in the app — it makes it impossible to
// leak a server module into the client bundle, and it was verified by a
// deliberate client-import probe that failed the build as intended.
//
// It also makes those modules untestable under Vitest, which is a plain Node
// process. Aliasing it to this empty module in the TEST config only keeps the
// production guard intact while letting the ledger be exercised against a real
// database. The alias exists in vitest.config.ts and nowhere else; `pnpm build`
// still resolves the real package.
export {};
