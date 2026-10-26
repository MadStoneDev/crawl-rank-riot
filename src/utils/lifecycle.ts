// Process lifecycle state shared across the app.
//
// On SIGTERM/SIGINT the server enters "shutting down": the scheduler stops, any
// in-flight scans are marked interrupted, and new scan requests are refused.
// Refusing new scans matters because the crawler is a single process — a scan
// accepted while the process is exiting can never finish, and would be left
// in_progress, blocking its project behind the 409 scan_in_progress guard until
// the next startup recovery clears it.

let shuttingDown = false;

/** Enter the shutting-down state. Idempotent. */
export function beginShutdown(): void {
  shuttingDown = true;
}

/** True once a shutdown signal has been received. Scan entry points check this
 *  and refuse to create a new scan. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only: clear the flag between cases. */
export function __resetShutdownForTests(): void {
  shuttingDown = false;
}
