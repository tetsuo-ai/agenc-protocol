# agenc-cli

Unscoped alias for
[`@tetsuo-ai/agenc-cli`](https://www.npmjs.com/package/@tetsuo-ai/agenc-cli) —
the AgenC marketplace onboarding CLI (`init` / `dev` / `promote`). This package
contains no logic of its own: its bin executes the scoped package's CLI entry,
and its only dependency is `@tetsuo-ai/agenc-cli`.

```bash
npx @tetsuo-ai/agenc-cli init
npx @tetsuo-ai/agenc-cli dev
npx @tetsuo-ai/agenc-cli promote
```

Unscoped `npx agenc-cli` still resolved to npm 0.2.0 when checked 2026-08-23
(workspace alias is 0.3.0). Use the scoped package until the alias is published.
`--dir <path>` is a global flag (default cwd).

Prefer the scoped package for anything long-lived:

```bash
npm install -D @tetsuo-ai/agenc-cli
npx agenc <init|dev|promote>
```

Full documentation:
[`@tetsuo-ai/agenc-cli`](https://github.com/tetsuo-ai/agenc-protocol/tree/main/packages/agenc-cli#readme).

## License

MIT
