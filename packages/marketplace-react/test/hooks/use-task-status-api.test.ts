import { describe, expect, it } from "vitest";
import type {
  ObservedEvent,
  TaskEventsSource,
  TaskEventsSourceFactory,
  UseTaskStatusOptions,
} from "../../src/hooks/index.js";

describe("useTaskStatus public event-source API", () => {
  it("accepts both the legacy AsyncIterable and abort-aware factory forms", () => {
    const legacy: TaskEventsSource = {
      async *[Symbol.asyncIterator]() {
        yield { source: "legacy" } satisfies ObservedEvent;
      },
    };
    const factory: TaskEventsSourceFactory = ({ signal, taskPda }) => ({
      async *[Symbol.asyncIterator]() {
        if (!signal.aborted) yield { source: "factory", taskPda };
      },
    });

    // These assignments are the compile-time public-API regression. Keeping
    // them in a Vitest module also ensures both values remain ordinary runtime
    // inputs after declaration generation/tree-shaking changes.
    const legacyOptions: UseTaskStatusOptions = { events: legacy };
    const factoryOptions: UseTaskStatusOptions = { events: factory };

    expect(legacyOptions.events).toBe(legacy);
    expect(factoryOptions.events).toBe(factory);
  });
});
