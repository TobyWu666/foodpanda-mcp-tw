/**
 * "Check the app first" lock, set when a checkout was sent but its outcome is
 * unknown. Kept in a small file in the state dir so restarting the MCP server
 * (for example by restarting the desktop app) does not clear it.
 *
 * The file holds only the time and a fixed reason: no order details, names,
 * addresses or foodpanda answers.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OrderCheckLock {
  at: string; // ISO 8601
  reason: string;
}

export const UNKNOWN_OUTCOME_REASON = "a checkout was sent and its outcome is unknown";

export class OrderCheckLockStore {
  private memory: OrderCheckLock | null = null;

  /** `file` null keeps the lock in memory only (tests). */
  constructor(private readonly file: string | null) {}

  get(): OrderCheckLock | null {
    if (!this.file) return this.memory;
    try {
      const data = JSON.parse(readFileSync(this.file, "utf-8"));
      if (data && typeof data.at === "string") {
        return { at: data.at, reason: typeof data.reason === "string" ? data.reason : UNKNOWN_OUTCOME_REASON };
      }
      // A file we cannot read properly still means "check first".
      return { at: "unknown time", reason: UNKNOWN_OUTCOME_REASON };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      return { at: "unknown time", reason: UNKNOWN_OUTCOME_REASON };
    }
  }

  set(at: Date = new Date()): void {
    const lock = { at: at.toISOString(), reason: UNKNOWN_OUTCOME_REASON };
    this.memory = lock;
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify(lock) + "\n", { mode: 0o600 });
  }

  clear(): void {
    this.memory = null;
    if (this.file) rmSync(this.file, { force: true });
  }
}
