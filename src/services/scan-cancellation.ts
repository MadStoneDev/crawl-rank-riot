// In-process registry of scans the user has asked to stop. The crawler runs as
// a single self-hosted instance, so an in-memory set is a reliable, cheap
// cancel signal: the /scan/:scanId/cancel route flags a scan here, the crawl
// loop checks it each batch and exits, and the pipeline finalises as cancelled.
const cancelled = new Set<string>();

export function requestCancel(scanId: string): void {
  cancelled.add(scanId);
}

export function isCancelled(scanId: string | null | undefined): boolean {
  return !!scanId && cancelled.has(scanId);
}

export function clearCancel(scanId: string): void {
  cancelled.delete(scanId);
}
