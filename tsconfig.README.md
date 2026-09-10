# Why there are two tsconfigs

`tsconfig.json` covers application code. `tsconfig.test.json` extends it and
adds the test files.

The split exists because `next build` typechecks whatever `tsconfig.json`
includes, and a test file that is mid-edit — or that references a module a
parallel worker has not landed yet — then fails the *deploy*. A broken test
should fail the test run and the CI gate. It should not be able to stop a
working application from shipping.

What did NOT change: `pnpm typecheck` still checks both configs, so CI and the
commit gate cover tests exactly as before. The only thing narrowed is what
`next build` looks at.

Use `pnpm typecheck:app` when you want the build's view specifically.
