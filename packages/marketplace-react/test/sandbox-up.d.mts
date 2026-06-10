/**
 * Type declarations for the JS bootstrap `sandbox-up.mjs` so TS test files that
 * import it (test/playwright/*) typecheck under the parent tsconfig.
 */
export const SANDBOX_PORT: number;

export interface SandboxFixturesListing {
  address: string;
  provider: string;
  name: string;
  category: string;
  priceLamports: number;
}

export interface SandboxFixtures {
  seeded: boolean;
  cluster: string;
  programId: string;
  seededAtSlot: number | null;
  providers: Array<{ authority: string; agent: string; name: string }>;
  listings: SandboxFixturesListing[];
}

export interface SandboxEnv {
  cluster: string;
  rpcUrl: string;
  rpcSubscriptionsUrl: string;
  programId: string;
  envFile: string;
  fixturesPath: string | null;
  fixtures: SandboxFixtures | null;
  keypairs: { authority: string; moderator: string; seeder: string } | null;
}

export interface StartOptions {
  port?: number;
  keepLedger?: boolean;
  seed?: boolean;
  quiet?: boolean;
}

export function readLocalnetEnv(envFile?: string): Promise<unknown | null>;
export function readSandboxFixtures(
  fixturesPath: string | null | undefined,
): Promise<SandboxFixtures | null>;
export function readSandboxEnv(envFile?: string): Promise<SandboxEnv | null>;
export function start(options?: StartOptions): Promise<SandboxEnv>;
export function stop(options?: { purge?: boolean; quiet?: boolean }): Promise<void>;
