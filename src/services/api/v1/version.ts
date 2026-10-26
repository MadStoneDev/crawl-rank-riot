// Versioning for the public /api/v1 jobs API (Stage 3).
//
// API_VERSION is the URL/surface version ("v1"); it only changes for a
// breaking redesign of the surface. SCHEMA_VERSION is the semantic version of
// the response bodies — bump the minor for additive, backwards-compatible
// fields and the major for a breaking shape change. Every v1 response carries
// both so a client (Vanward) can assert what it is parsing.

export const API_VERSION = "v1" as const;
// 1.1.0 (Stage 4): additive — projects, job scope + modules + attribution, and
// the per-job pages endpoints. All 1.0.0 fields are unchanged.
// 1.2.0 (PC-07): additive — business_info.opening_hours_structured
// ({ day, opens, closes } per day) alongside the existing opening_hours text.
// All earlier fields are unchanged.
export const SCHEMA_VERSION = "1.2.0" as const;
