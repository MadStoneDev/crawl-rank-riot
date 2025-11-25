import { getSupabaseServiceClient } from "./database/client";
import { Database } from "../database.types";

type AuditResultInsert =
  Database["public"]["Tables"]["audit_results"]["Insert"];

/**
 * Store audit results in the database
 */
export async function storeAuditResults(
  projectId: string,
  scanId: string,
  auditData: any,
): Promise<void> {
  const supabase = getSupabaseServiceClient();

  try {
    console.log(`💾 Storing audit results for scan ${scanId}...`);

    // Explicitly type the insert data
    const insertData: AuditResultInsert = {
      scan_id: scanId,
      project_id: projectId,
      modernization_score: auditData.modernization_score,
      performance_score: auditData.performance_score,
      completeness_score: auditData.completeness_score,
      conversion_score: auditData.conversion_score,
      overall_score: auditData.overall_score,
      tech_stack: auditData.tech_stack,
      design_analysis: auditData.design_analysis,
      missing_pages: auditData.missing_pages,
      found_pages: auditData.found_pages,
      performance_metrics: auditData.performance_metrics,
      modern_standards: auditData.modern_standards,
      recommendations: auditData.recommendations,
    };

    const { error } = await supabase.from("audit_results").insert(insertData);

    if (error) {
      console.error("Error storing audit results:", error);
      throw error;
    }

    console.log("✅ Audit results stored successfully");
  } catch (error) {
    console.error("Error in storeAuditResults:", error);
    throw error;
  }
}

/**
 * Get audit results from database
 */
export async function getAuditResults(scanId: string): Promise<any> {
  const supabase = getSupabaseServiceClient();

  try {
    const { data, error } = await supabase
      .from("audit_results")
      .select("*")
      .eq("scan_id", scanId)
      .single();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    console.error("Error fetching audit results:", error);
    throw error;
  }
}
