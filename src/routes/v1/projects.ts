// /api/v1/projects — manage the sites a key owner scans (Stage 4).
//
// A project lives in the shared `projects` table (owned by the key's user); its
// API attribution (external_ref + metadata) lives in the api_projects side
// table. Create dedupes by normalised domain per owner.

import { Router, Response } from "express";
import { getSupabaseServiceClient } from "../../services/database/client";
import { ApiKeyRequest, requireScope } from "../../middleware/api-key-auth";
import { sendV1, sendV1Error } from "../../services/api/v1/respond";
import { serializeProject, domainOf, type ProjectRow } from "../../services/api/v1/serializers";
import { stage4Db } from "../../services/api/v1/stage4-db";

const router = Router();

interface ApiProjectAttrs {
  project_id: string;
  external_ref: string | null;
  metadata: Record<string, unknown> | null;
}

/** Load api_projects attributes for a set of project ids. */
async function loadAttrs(projectIds: string[]): Promise<Map<string, ApiProjectAttrs>> {
  const byId = new Map<string, ApiProjectAttrs>();
  if (projectIds.length === 0) return byId;
  const { data } = await stage4Db()
    .from("api_projects")
    .select("project_id, external_ref, metadata")
    .in("project_id", projectIds);
  for (const row of (data ?? []) as ApiProjectAttrs[]) byId.set(row.project_id, row);
  return byId;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// POST /api/v1/projects — create (or return the existing) project for a domain.
router.post("/projects", requireScope("projects:write"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const userId = req.apiKey!.user_id;
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const rawDomain = typeof req.body?.domain === "string" ? req.body.domain.trim() : "";
    const rawUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!rawDomain && !rawUrl) {
      sendV1Error(res, 400, "validation_error", "A domain or url is required.");
      return;
    }
    if (!name) {
      sendV1Error(res, 400, "validation_error", "name is required.");
      return;
    }
    if (req.body?.metadata !== undefined && !isPlainObject(req.body.metadata)) {
      sendV1Error(res, 400, "validation_error", "metadata must be a JSON object.");
      return;
    }

    // Normalise to a canonical https origin + bare domain.
    const domain = domainOf(rawUrl || rawDomain);
    if (!domain) {
      sendV1Error(res, 400, "validation_error", "Could not parse a domain from the input.");
      return;
    }
    const url = `https://${domain}/`;
    const external_ref = typeof req.body?.external_ref === "string" ? req.body.external_ref : null;
    const metadata = isPlainObject(req.body?.metadata) ? req.body.metadata : {};

    const supabase = getSupabaseServiceClient();
    const db = stage4Db();

    // Dedupe by normalised domain among the owner's (non-deleted) projects.
    const { data: existing } = await supabase
      .from("projects")
      .select("id, name, url, created_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .limit(1000);
    const match = (existing ?? []).find((p) => domainOf(p.url) === domain);
    if (match) {
      // Keep attribution current on the existing project.
      await db
        .from("api_projects")
        .upsert(
          { project_id: match.id, user_id: userId, external_ref, metadata, updated_at: new Date().toISOString() },
          { onConflict: "project_id" },
        );
      sendV1(res, 200, serializeProject(match as ProjectRow, { external_ref, metadata }));
      return;
    }

    const { data: created, error: createError } = await supabase
      .from("projects")
      .insert({ user_id: userId, name, url })
      .select("id, name, url, created_at")
      .single();
    if (createError || !created) {
      sendV1Error(res, 500, "database_error", "Could not create the project.");
      return;
    }
    await db
      .from("api_projects")
      .insert({ project_id: created.id, user_id: userId, external_ref, metadata });

    sendV1(res, 201, serializeProject(created as ProjectRow, { external_ref, metadata }));
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not create the project.");
  }
});

// GET /api/v1/projects — list the owner's projects (filter by external_ref).
router.get("/projects", requireScope("projects:read"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const userId = req.apiKey!.user_id;
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 25, 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const externalRef = typeof req.query.external_ref === "string" ? req.query.external_ref : null;
    const supabase = getSupabaseServiceClient();
    const db = stage4Db();

    let projectIds: string[] | null = null;
    if (externalRef !== null) {
      // Filter is on an api_projects attribute → resolve ids first.
      const { data } = await db
        .from("api_projects")
        .select("project_id")
        .eq("user_id", userId)
        .eq("external_ref", externalRef);
      projectIds = ((data ?? []) as Array<{ project_id: string }>).map((r) => r.project_id);
      if (projectIds.length === 0) {
        sendV1(res, 200, { object: "list", items: [], page: { limit, offset, has_more: false } });
        return;
      }
    }

    let query = supabase
      .from("projects")
      .select("id, name, url, created_at")
      .eq("user_id", userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit);
    if (projectIds) query = query.in("id", projectIds);
    const { data: projects } = await query;

    const rows = (projects ?? []).slice(0, limit);
    const attrs = await loadAttrs(rows.map((p) => p.id));
    const items = rows.map((p) => {
      const a = attrs.get(p.id);
      return serializeProject(p as ProjectRow, a ? { external_ref: a.external_ref, metadata: a.metadata } : null);
    });
    const hasMore = (projects ?? []).length > limit;
    sendV1(res, 200, { object: "list", items, page: { limit, offset, has_more: hasMore } });
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not list projects.");
  }
});

// GET /api/v1/projects/:id — one project owned by the key's user.
router.get("/projects/:id", requireScope("projects:read"), async (req: ApiKeyRequest, res: Response): Promise<void> => {
  try {
    const userId = req.apiKey!.user_id;
    const supabase = getSupabaseServiceClient();
    const { data: project } = await supabase
      .from("projects")
      .select("id, name, url, created_at, user_id, deleted_at")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!project || project.user_id !== userId || project.deleted_at) {
      sendV1Error(res, 404, "project_not_found", "No project with that id for this API key.");
      return;
    }
    const attrs = await loadAttrs([project.id]);
    const a = attrs.get(project.id);
    sendV1(res, 200, serializeProject(project as ProjectRow, a ? { external_ref: a.external_ref, metadata: a.metadata } : null));
  } catch {
    sendV1Error(res, 500, "internal_error", "Could not load the project.");
  }
});

export default router;
