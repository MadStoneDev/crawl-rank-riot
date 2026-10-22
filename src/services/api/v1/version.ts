// Versioning for the public /api/v1 jobs API (Stage 3).
//
// API_VERSION is the URL/surface version ("v1"); it only changes for a
// breaking redesign of the surface. SCHEMA_VERSION is the semantic version of
// the response bodies — bump the minor for additive, backwards-compatible
// fields and the major for a breaking shape change. Every v1 response carries
// both so a client (Vanward) can assert what it is parsing.

export const API_VERSION = "v1" as const;
export const SCHEMA_VERSION = "1.0.0" as const;
