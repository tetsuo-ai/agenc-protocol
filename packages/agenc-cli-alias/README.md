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

`npx agenc-cli` runs the same CLI as the scoped package. Alias 0.4.0 depends on
`@tetsuo-ai/agenc-cli` `^0.4.0`. `--dir <path>` is a global flag (default cwd).

Prefer the scoped package for anything long-lived:

```bash
npm install -D @tetsuo-ai/agenc-cli
npx agenc <init|dev|promote>
```

Full documentation:
[`@tetsuo-ai/agenc-cli`](https://github.com/tetsuo-ai/agenc-protocol/tree/main/packages/agenc-cli#readme).

## License

MIT
