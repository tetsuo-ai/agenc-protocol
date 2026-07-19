import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const fixtureNodeModules = path.join(
  repoRoot,
  "packages/marketplace-react/test-apps/next-ssr/node_modules",
);
const nextBin = path.join(fixtureNodeModules, ".bin", "next");

for (const router of ["app", "pages"]) {
  const project = mkdtempSync(path.join(tmpdir(), `agenc-next-${router}-`));
  try {
    writeFileSync(
      path.join(project, "package.json"),
      JSON.stringify({
        name: `agenc-generated-${router}`,
        private: true,
        scripts: { build: "next build" },
        dependencies: {
          "@solana/kit": "6.9.0",
          "@tetsuo-ai/marketplace-sdk": "0.12.0",
          next: "15.5.20",
          react: "18.3.1",
          "react-dom": "18.3.1",
        },
      }),
    );
    writeFileSync(
      path.join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["dom", "dom.iterable", "esnext"],
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          plugins: [{ name: "next" }],
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      }),
    );
    if (router === "app") {
      mkdirSync(path.join(project, "app"));
      writeFileSync(
        path.join(project, "app", "layout.tsx"),
        "export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n",
      );
    } else {
      mkdirSync(path.join(project, "pages"));
    }
    const initialized = runInit(project, {
      kind: "checkout",
      router,
    });
    if (initialized.refused) {
      throw new Error(`agenc init refused generated ${router} fixture`);
    }
    symlinkSync(fixtureNodeModules, path.join(project, "node_modules"), "dir");
    execFileSync(nextBin, ["build"], {
      cwd: project,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: "inherit",
      timeout: 180_000,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}
