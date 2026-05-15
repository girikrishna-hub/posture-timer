#!/usr/bin/env node
/**
 * Kill any process listening on PORT (env var) or the first CLI argument.
 * Uses /proc/net/tcp[6] so it works on Linux without lsof/fuser/ss.
 * Safe to call even when nothing holds the port — exits 0 either way.
 */
import { readFileSync, readdirSync, readlinkSync } from "fs";

const port = parseInt(process.env.PORT ?? process.argv[2] ?? "8080", 10);
const hexPort = port.toString(16).toUpperCase().padStart(4, "0");

// Collect socket inodes that are in LISTEN state (0A) on this port.
const inodes = new Set();
for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  try {
    const lines = readFileSync(file, "utf-8").split("\n").slice(1);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      // cols[1] = "HEXIP:HEXPORT", cols[3] = state, cols[9] = inode
      if (cols[1]?.toUpperCase().endsWith(":" + hexPort) && cols[3] === "0A") {
        inodes.add(cols[9]);
      }
    }
  } catch {
    // file may not exist on non-Linux or inside certain sandboxes
  }
}

if (inodes.size === 0) process.exit(0);

// Walk /proc/<pid>/fd symlinks to find the PID that owns each socket inode.
let killed = 0;
for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m && inodes.has(m[1])) {
          process.kill(Number(pid), "SIGKILL");
          console.log(`[kill-port] killed PID ${pid} holding port ${port}`);
          killed++;
          break;
        }
      } catch {
        // fd may have disappeared between readdir and readlink — ignore
      }
    }
  } catch {
    // /proc/<pid> may have disappeared — ignore
  }
}

if (killed > 0) {
  // Give the OS a moment to release the port before the caller tries to bind.
  await new Promise((r) => setTimeout(r, 300));
}
