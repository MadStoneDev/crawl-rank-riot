// types.ts - Type definitions for the crawler system

export interface CrawlOptions {
    maxDepth?: number;
    maxPages?: number;
    concurrentRequests?: number;
    timeout?: number;
    excludePatterns?: RegExp[];
    checkSitemaps?: boolean;
    useHeadlessBrowser?: boolean;
    headlessBrowserPaths?: string[];
    useRedisQueue?: boolean;
    perDomainDelay?: number;
    defaultDelay?: number;
}

export interface Link {
    url: string;
    text?: string;
    status?: number;
    is_redirect?: boolean;
}

export interface ScanResult {
    url: string;
    status: number;
    title?: string;
    meta_description?: string;
    h1?: string;
    content_type?: string;
    depth: number;
    internal_links: Link[];
    external_links: Link[];
    images?: {
        url: string;
        alt?: string;
        dimensions?: {
            width?: number;
            height?: number;
        };
    }[];
    errors?: string[];
    warnings?: string[];
    scan_method?: 'standard' | 'headless';
    load_time_ms?: number;
    redirected_from?: string;
    scanned_at: string;
}

export interface QueueItem {
    url: string;
    depth: number;
    priority?: number;
    retries?: number;
}

export interface RobotsData {
    sitemaps: string[];
    crawlDelay?: number;
    allowedPaths: string[];
    disallowedPaths: string[];
}

export interface QueueManagerOptions {
    redis: any | null;
    scanId?: string;
    domain: string;
    perDomainDelay?: number;
    defaultDelay?: number;
}

export interface StateManagerOptions {
    redis: any | null;
    scanId?: string;
    supabase?: any;
}

export interface SitemapProcessorOptions {
    userAgent?: string;
    timeout?: number;
}