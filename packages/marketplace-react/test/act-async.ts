import { act } from "@testing-library/react";

type ActOutcome<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/** Run an async hook action through React's complete update boundary. */
export async function actAsync<T>(operation: () => Promise<T>): Promise<T> {
  let outcome: ActOutcome<T> | undefined;
  await act(async () => {
    try {
      outcome = { status: "fulfilled", value: await operation() };
    } catch (reason) {
      outcome = { status: "rejected", reason };
    }
  });
  if (!outcome) {
    throw new Error("actAsync: operation completed without an outcome");
  }
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}
