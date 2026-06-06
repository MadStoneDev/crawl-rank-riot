import { getSupabaseServiceClient } from "./database/client";

export type LogLevel = "info" | "warn" | "error";
export type LogStage = "init" | "sitemap" | "crawl" | "store" | "analysis" | "complete";

interface LogEntry {
  level: LogLevel;
  stage: LogStage;
  message: string;
  metadata?: Record<string, any>;
}

export class ScanLogger {
  private scanId: string;
  private buffer: LogEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(scanId: string) {
    this.scanId = scanId;
    this.flushInterval = setInterval(() => this.flush(), 2000);
  }

  info(stage: LogStage, message: string, metadata?: Record<string, any>) {
    this.log("info", stage, message, metadata);
  }

  warn(stage: LogStage, message: string, metadata?: Record<string, any>) {
    this.log("warn", stage, message, metadata);
  }

  error(stage: LogStage, message: string, metadata?: Record<string, any>) {
    this.log("error", stage, message, metadata);
  }

  private log(level: LogLevel, stage: LogStage, message: string, metadata?: Record<string, any>) {
    const prefix = level === "error" ? "❌" : level === "warn" ? "⚠️" : "📋";
    console.log(`${prefix} [${stage}] ${message}`);
    this.buffer.push({ level, stage, message, metadata: metadata || undefined });
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const entries = this.buffer.splice(0);
    try {
      const supabase = getSupabaseServiceClient();
      const rows = entries.map((e) => ({
        scan_id: this.scanId,
        level: e.level,
        stage: e.stage,
        message: e.message,
        metadata: e.metadata ?? null,
      }));

      const { error } = await (supabase as any).from("scan_logs").insert(rows);
      if (error) {
        console.error("Failed to write scan logs:", error.message);
        // Put entries back so they aren't lost
        this.buffer.unshift(...entries);
      }
    } catch (err) {
      console.error("Scan logger flush error:", err);
      this.buffer.unshift(...entries);
    } finally {
      this.flushing = false;
    }
  }

  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    await this.flush();
  }
}
