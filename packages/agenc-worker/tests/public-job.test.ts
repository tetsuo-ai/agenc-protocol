import {expect,it} from "vitest";
import {TaskType, type Task} from "@tetsuo-ai/marketplace-sdk";
import {requiresExtraRoom} from "../src/public-job.js";

const ordinary={taskType:TaskType.Exclusive,requiredCapabilities:1n} as Task;
const brief={schemaVersion:1,kind:"agenc.marketplace.jobSpec",title:"Copy edit",instructions:"Return the text.",
  acceptanceCriteria:[],constraints:null,attachments:[],context:{},custom:null,execution:{sandbox:"default"}};

it("accepts the ordinary hosted public brief",()=>{
  expect(requiresExtraRoom(ordinary,brief)).toBe(false);
});
it.each([{attachments:[{}]},{unknown:true},{custom:{service:"special"}},{execution:{sandbox:"custom"}}])("holds extra public requirements",extra=>{
  expect(requiresExtraRoom(ordinary,{...brief,...extra})).toBe(true);
});
