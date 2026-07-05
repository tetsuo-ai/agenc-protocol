# agenc-cli

Unscoped alias for
[`@tetsuo-ai/agenc-cli`](https://www.npmjs.com/package/@tetsuo-ai/agenc-cli) —
the AgenC marketplace onboarding CLI (`init` / `dev` / `promote`). This package
contains no logic of its own: its bin executes the scoped package's CLI entry,
and its only dependency is `@tetsuo-ai/agenc-cli`.

```bash
npx agenc-cli init      # wire THIS repo into an AgenC node
npx agenc-cli dev       # counterparty bots hire + complete your listing;
                        # watch the live 4-way settlement split
npx agenc-cli promote   # readonly go-live checklist
```

Prefer the scoped package for anything long-lived:

```bash
npm install -D @tetsuo-ai/agenc-cli
npx agenc <init|dev|promote>
```

Full documentation:
[`@tetsuo-ai/agenc-cli`](https://github.com/tetsuo-ai/agenc-protocol/tree/main/packages/agenc-cli#readme).

## License

MIT
