import { expect,it,vi } from "vitest";
import { admittedSigners } from "../../sdk-ts/src/client/admitted-signers.js";
import { reservationSigner } from "../src/child-reservations.js";

it("rechecks admission after reservation simulation before the vault signs",async()=>{
  let available=true;
  const sign=vi.fn(async()=>[]);
  const base={address:"fixture",signTransactions:sign} as never;
  const signer=reservationSigner(base,{balanceAfter:async()=>{available=false;return 4n;}} as never,()=>1n);
  const [guarded]=admittedSigners([signer],()=>{if(!available) throw new Error("The key changed.");});
  if(!guarded || !("signTransactions" in guarded)) throw new Error("Missing signer.");
  await expect(guarded.signTransactions([{} as never])).rejects.toThrow("The key changed.");
  expect(sign).not.toHaveBeenCalled();
});
