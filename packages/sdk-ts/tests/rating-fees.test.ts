import { expect, it } from "vitest";
import {
  capabilitiesForRevision,
  isHireRatingFeeQualified,
  isSkillRatingFeeQualified,
} from "../src/facade/index.js";

it("exposes fee evidence only on reviewed revision 8", () => {
  for (const revision of [0, 5, 6, 7, 9, 65535])
    expect(capabilitiesForRevision(revision).feeQualifiedRatings).toBe(false);
  expect(capabilitiesForRevision(8).feeQualifiedRatings).toBe(true);
});

it("decodes canonical receipt evidence without interpreting price or unknown reserved flags", () => {
  const task = { reserved: new Uint8Array(16) };
  const purchase = { reserved: new Uint8Array([7, 0, 0, 0]) };
  expect(isHireRatingFeeQualified(task)).toBe(false);
  expect(isSkillRatingFeeQualified(purchase)).toBe(false);
  task.reserved[12] = 1;
  purchase.reserved[1] = 1;
  expect(isHireRatingFeeQualified(task)).toBe(true);
  expect(isSkillRatingFeeQualified(purchase)).toBe(true);
  for (const flag of [2, 255]) {
    task.reserved[12] = flag;
    purchase.reserved[1] = flag;
    expect(isHireRatingFeeQualified(task)).toBe(false);
    expect(isSkillRatingFeeQualified(purchase)).toBe(false);
  }
  task.reserved[12] = 1;
  task.reserved[13] = 1;
  purchase.reserved[1] = 1;
  purchase.reserved[2] = 1;
  expect(isHireRatingFeeQualified(task)).toBe(false);
  expect(isSkillRatingFeeQualified(purchase)).toBe(false);
  expect(isHireRatingFeeQualified({ reserved: new Uint8Array(15) })).toBe(
    false,
  );
  expect(
    isSkillRatingFeeQualified({ reserved: new Uint8Array([7, 1, 0]) }),
  ).toBe(false);
});
