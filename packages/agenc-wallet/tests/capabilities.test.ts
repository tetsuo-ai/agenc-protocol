import { expect, it } from "vitest";
import { WALLET_CAPABILITIES } from "../src/client/index.js";

it("exports exactly the documented wallet capabilities", () => {
  expect(WALLET_CAPABILITIES).toEqual(["earn-finishing"]);
});
