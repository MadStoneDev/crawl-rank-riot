/**
 * Check if a URL belongs to a JavaScript-heavy platform
 * that requires headless browser rendering for proper scanning.
 */
export function isJavaScriptHeavySite(url: string): boolean {
  const jsHeavyPlatforms = [
    "shopify.com",
    "shopifypreview.com",
    "myshopify.com",
    "squarespace.com",
    "wix.com",
    "webflow.io",
    "bigcommerce.com",
    "magento.com",
  ];

  const lowerUrl = url.toLowerCase();
  return jsHeavyPlatforms.some((platform) => lowerUrl.includes(platform));
}
