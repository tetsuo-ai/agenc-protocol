// rt5 A 6: the job view said "At most $0.05" (the first run's share) while the
// claim quote told the agent the job's limit was $0.10.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { recordServiceBudget, serviceBudget } from "../src/service-budget.js";
import { reserveServiceRun, serviceUsage } from "../src/service-usage.js";

describe("the whole job's model budget", () => {
  it("sits beside the run reservations, so the job view can name the job's limit", () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "budget-"));
    reserveServiceRun(root, "task", 6);
    expect(serviceUsage(root, "task")).not.toHaveProperty("budgetCents");
    recordServiceBudget(root, "task", 10);
    expect(serviceUsage(root, "task")).toEqual({ costUsd: null, runs: 1, reservedCents: 6, unknownReservedCents: 6, budgetCents: 10 });
  });
  it("records nothing that is not a whole positive number of cents", () => {
    const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "budget-"));
    recordServiceBudget(root, "task", 0);
    recordServiceBudget(root, "task", 1.5);
    expect(serviceBudget(root, "task")).toBeNull();
  });
});
