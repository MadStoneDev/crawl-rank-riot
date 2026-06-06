-- Stores detailed crawl logs for admin visibility
CREATE TABLE public.scan_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scan_id uuid NOT NULL REFERENCES public.scans(id) ON DELETE CASCADE,
    timestamp timestamptz DEFAULT now() NOT NULL,
    level text NOT NULL DEFAULT 'info', -- info, warn, error
    stage text NOT NULL, -- init, sitemap, crawl, store, analysis, complete
    message text NOT NULL,
    metadata jsonb DEFAULT NULL -- optional structured data (url, status code, timing, etc.)
);

CREATE INDEX idx_scan_logs_scan_id ON public.scan_logs(scan_id);
CREATE INDEX idx_scan_logs_scan_id_timestamp ON public.scan_logs(scan_id, timestamp);

-- RLS: only service role writes, admin reads
ALTER TABLE public.scan_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON public.scan_logs
    FOR ALL USING (true) WITH CHECK (true);
