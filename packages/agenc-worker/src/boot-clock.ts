import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { uptime } from "node:os";

// Use the same suspend-inclusive boot clock in the wallet and its room program.
export function monotonicMs(): number {
  let ms: number;
  if (process.platform === "linux") {
    ms = Number(readFileSync("/proc/uptime", "ascii").split(" ")[0]) * 1000;
  } else if (process.platform === "darwin") {
    // Darwin CLOCK_MONOTONIC_RAW uses mach_continuous_time and includes sleep.
    ms =
      Number(
        execFileSync(
          "/usr/bin/perl",
          ["-MTime::HiRes=clock_gettime", "-e", "print clock_gettime(4)"],
          {
            encoding: "ascii",
            env: { LC_ALL: "C" },
            timeout: 1000,
          },
        ),
      ) * 1000;
  } else if (process.platform === "win32") ms = uptime() * 1000;
  else throw new Error("The suspend-inclusive claim clock is unavailable.");
  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error("The claim clock is unavailable.");
  return Math.floor(ms);
}
