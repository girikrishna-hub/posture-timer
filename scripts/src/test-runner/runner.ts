import { Reporter } from "./reporter.js";
import type { RunnerConfig } from "./types.js";

export interface Flow {
  name: string;
  requiresAuth: boolean;
  run(config: RunnerConfig, reporter: Reporter): Promise<void>;
}

export interface RunConfig {
  flows: Flow[];
  repeat?: number;
  baseUrl?: string;
  verbose?: boolean;
  parallel?: boolean;
}

function buildConfig(runConfig: RunConfig): RunnerConfig {
  return {
    baseUrl: runConfig.baseUrl ?? process.env["TEST_BASE_URL"] ?? "http://localhost:80/api",
    authToken: process.env["TEST_AUTH_TOKEN"] ?? null,
    verbose: runConfig.verbose ?? process.env["TEST_VERBOSE"] === "1",
  };
}

async function runFlow(
  flow: Flow,
  config: RunnerConfig,
  reporter: Reporter,
): Promise<void> {
  try {
    await flow.run(config, reporter);
  } catch {
    // Error already recorded in reporter; swallow so runner continues
  }
}

export async function run(runConfig: RunConfig): Promise<void> {
  const config = buildConfig(runConfig);
  const reporter = new Reporter();
  const repeat = runConfig.repeat ?? 1;

  console.log(`\n${"═".repeat(52)}`);
  console.log("  Sit/Stand Timer — System Test Runner");
  console.log(`${"═".repeat(52)}`);
  console.log(`  base URL : ${config.baseUrl}`);
  console.log(`  auth     : ${config.authToken ? "✓ token set" : "✗ no token (auth flows will skip)"}`);
  console.log(`  flows    : ${runConfig.flows.map((f) => f.name).join(", ")}`);
  console.log(`  repeat   : ${repeat}x`);
  console.log(`${"═".repeat(52)}`);

  for (let run = 1; run <= repeat; run++) {
    if (repeat > 1) {
      console.log(`\n${"─".repeat(52)}`);
      console.log(`  Run ${run} of ${repeat}`);
      console.log(`${"─".repeat(52)}`);
    }

    if (runConfig.parallel) {
      // Run all flows in parallel (useful for stress testing non-conflicting flows)
      await Promise.all(runConfig.flows.map((f) => runFlow(f, config, reporter)));
    } else {
      // Sequential — default; ensures flows don't interfere with each other
      for (const flow of runConfig.flows) {
        await runFlow(flow, config, reporter);
      }
    }
  }

  reporter.summary();
}
