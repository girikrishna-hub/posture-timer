import { run } from "./test-runner/runner.js";
import { sessionFlow } from "./test-runner/flows/sessionFlow.js";
import { pushFlow } from "./test-runner/flows/pushFlow.js";
import { concurrencyFlow } from "./test-runner/flows/concurrencyFlow.js";
import { recoveryFlow } from "./test-runner/flows/recoveryFlow.js";

const repeat = process.env["TEST_REPEAT"] ? parseInt(process.env["TEST_REPEAT"], 10) : 1;

await run({
  flows: [sessionFlow, pushFlow, concurrencyFlow, recoveryFlow],
  repeat,
});
