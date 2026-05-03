import type { FlowResult } from "./types.js";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";

export class Reporter {
  private results: FlowResult[] = [];
  private flowStart: number = Date.now();
  private currentFlow: string = "";

  startFlow(name: string): void {
    this.flowStart = Date.now();
    this.currentFlow = name;
    console.log(`\n${BOLD}${CYAN}▶ ${name}${RESET}`);
  }

  step(stepName: string, detail?: string): void {
    const suffix = detail ? ` ${DIM}${detail}${RESET}` : "";
    console.log(`  ${DIM}·${RESET} ${stepName}${suffix}`);
  }

  pass(name: string): void {
    const ms = Date.now() - this.flowStart;
    this.results.push({ name, status: "pass", durationMs: ms });
    console.log(`  ${GREEN}✓ PASS${RESET} ${DIM}(${ms}ms)${RESET}`);
  }

  fail(name: string, error: unknown): void {
    const ms = Date.now() - this.flowStart;
    const message = error instanceof Error ? error.message : String(error);
    this.results.push({ name, status: "fail", durationMs: ms, error: message });
    console.log(`  ${RED}✗ FAIL${RESET} ${DIM}(${ms}ms)${RESET}`);
    console.log(`    ${RED}${message}${RESET}`);
  }

  skip(name: string, reason: string): void {
    this.results.push({ name, status: "skip", durationMs: 0, skipReason: reason });
    console.log(`  ${YELLOW}⊘ SKIP${RESET} — ${reason}`);
  }

  summary(): void {
    const passes = this.results.filter((r) => r.status === "pass").length;
    const fails = this.results.filter((r) => r.status === "fail").length;
    const skips = this.results.filter((r) => r.status === "skip").length;
    const total = this.results.length;

    console.log(`\n${"─".repeat(52)}`);
    console.log(`${BOLD}Results: ${total} flows${RESET}`);
    if (passes) console.log(`  ${GREEN}✓ ${passes} passed${RESET}`);
    if (fails) console.log(`  ${RED}✗ ${fails} failed${RESET}`);
    if (skips) console.log(`  ${YELLOW}⊘ ${skips} skipped${RESET}`);

    if (fails > 0) {
      console.log(`\n${RED}${BOLD}Failed flows:${RESET}`);
      for (const r of this.results.filter((r) => r.status === "fail")) {
        console.log(`  ${RED}✗ ${r.name}${RESET}`);
        console.log(`    ${DIM}${r.error}${RESET}`);
      }
    }

    console.log(`${"─".repeat(52)}`);
    console.log(fails > 0 ? `${RED}${BOLD}FAILED${RESET}` : `${GREEN}${BOLD}ALL PASSED${RESET}`);

    if (fails > 0) process.exit(1);
  }

  getResults(): FlowResult[] {
    return this.results;
  }
}
