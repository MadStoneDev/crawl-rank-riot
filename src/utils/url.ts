export class UrlProcessor {
  private domain: string;
  private baseUrl: URL;

  constructor(baseUrl: string) {
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      baseUrl = "https://" + baseUrl;
    }

    this.baseUrl = new URL(baseUrl);
    this.domain = this.baseUrl.hostname;
  }

  getDomain(): string {
    return this.domain;
  }

  normalize(url: string): string {
    try {
      const urlObj = new URL(url);
      let normalized = `${urlObj.protocol}//${urlObj.hostname.toLowerCase()}${
        urlObj.pathname
      }`;

      // Remove trailing slash for non-root paths
      if (normalized.length > 1 && normalized.endsWith("/")) {
        normalized = normalized.slice(0, -1);
      }

      // Keep query params
      if (urlObj.search) {
        normalized += urlObj.search;
      }

      return normalized;
    } catch (error) {
      return url;
    }
  }

  resolve(base: string, relative: string): string {
    try {
      if (!relative || relative === "#" || relative.startsWith("javascript:")) {
        return "";
      }

      const fullUrl = new URL(relative, base).toString();
      return this.normalize(fullUrl);
    } catch (error) {
      return "";
    }
  }

  isInternal(url: string): boolean {
    try {
      if (url.startsWith("mailto:") || url.startsWith("tel:")) {
        return false;
      }

      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();

      return (
        hostname === this.domain.toLowerCase() ||
        hostname === `www.${this.domain.toLowerCase()}` ||
        `www.${hostname}` === this.domain.toLowerCase()
      );
    } catch (error) {
      return false;
    }
  }
}
