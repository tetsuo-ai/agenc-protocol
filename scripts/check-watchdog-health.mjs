import { readFileSync } from "node:fs";
try {
  const health = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const age = Date.now() - Date.parse(health.checkedAt);
  if (
    health.state !== "healthy" ||
    !Number.isFinite(age) ||
    age < -1000 ||
    age > 30000
  )
    throw new Error("watchdog is stale or degraded");
  console.log("watchdog healthy");
} catch {
  console.error("watchdog health check failed");
  process.exitCode = 1;
}
