import { run } from "./test-runner/runner.js";
import { sessionFlow } from "./test-runner/flows/sessionFlow.js";
import { pushFlow } from "./test-runner/flows/pushFlow.js";
import { concurrencyFlow } from "./test-runner/flows/concurrencyFlow.js";
import { recoveryFlow } from "./test-runner/flows/recoveryFlow.js";
import { restartFlow } from "./test-runner/flows/restartFlow.js";
import { subscriptionFlow } from "./test-runner/flows/subscriptionFlow.js";
import { durationFlow } from "./test-runner/flows/durationFlow.js";

const repeat = process.env["TEST_REPEAT"] ? parseInt(process.env["TEST_REPEAT"], 10) : 1;

await run({
  flows: [
    sessionFlow,
    pushFlow,
    concurrencyFlow,
    recoveryFlow,
    restartFlow,
    subscriptionFlow,
    durationFlow,
  ],
  repeat,
});
