export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "12.2.12"
  }
  public: {
    Tables: {
      audit_results: {
        Row: {
          id: string
          scan_id: string | null
          project_id: string | null
          modernization_score: number | null
          performance_score: number | null
          completeness_score: number | null
          conversion_score: number | null
          overall_score: number | null
          tech_stack: Json | null
          design_analysis: Json | null
          missing_pages: Json | null
          performance_metrics: Json | null
          recommendations: Json | null
          created_at: string | null
          found_pages: Json | null
          modern_standards: Json | null
          broken_assets: Json | null
        }
        Insert: {
          id?: string
          scan_id?: string | null
          project_id?: string | null
          modernization_score?: number | null
          performance_score?: number | null
          completeness_score?: number | null
          conversion_score?: number | null
          overall_score?: number | null
          tech_stack?: Json | null
          design_analysis?: Json | null
          missing_pages?: Json | null
          performance_metrics?: Json | null
          recommendations?: Json | null
          created_at?: string | null
          found_pages?: Json | null
          modern_standards?: Json | null
          broken_assets?: Json | null
        }
        Update: {
          id?: string
          scan_id?: string | null
          project_id?: string | null
          modernization_score?: number | null
          performance_score?: number | null
          completeness_score?: number | null
          conversion_score?: number | null
          overall_score?: number | null
          tech_stack?: Json | null
          design_analysis?: Json | null
          missing_pages?: Json | null
          performance_metrics?: Json | null
          recommendations?: Json | null
          created_at?: string | null
          found_pages?: Json | null
          modern_standards?: Json | null
          broken_assets?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_results_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_results_scan_id_fkey"
            columns: ["scan_id"]
            isOneToOne: false
            referencedRelation: "scans"
            referencedColumns: ["id"]
          },
        ]
      }
      backlinks: {
        Row: {
          id: string
          project_id: string
          page_id: string | null
          source_url: string
          source_domain: string
          anchor_text: string | null
          first_seen_at: string | null
          last_seen_at: string | null
          is_followed: boolean | null
          domain_authority: number | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          page_id?: string | null
          source_url: string
          source_domain: string
          anchor_text?: string | null
          first_seen_at?: string | null
          last_seen_at?: string | null
          is_followed?: boolean | null
          domain_authority?: number | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          page_id?: string | null
          source_url?: string
          source_domain?: string
          anchor_text?: string | null
          first_seen_at?: string | null
          last_seen_at?: string | null
          is_followed?: boolean | null
          domain_authority?: number | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "backlinks_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backlinks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      competitors: {
        Row: {
          id: string
          project_id: string
          domain: string
          notes: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          domain: string
          notes?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          domain?: string
          notes?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "competitors_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      issues: {
        Row: {
          id: string
          project_id: string
          scan_id: string
          page_id: string
          issue_type: string
          severity: string
          description: string
          details: Json | null
          is_fixed: boolean | null
          fixed_at: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          scan_id: string
          page_id: string
          issue_type: string
          severity: string
          description: string
          details?: Json | null
          is_fixed?: boolean | null
          fixed_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          scan_id?: string
          page_id?: string
          issue_type?: string
          severity?: string
          description?: string
          details?: Json | null
          is_fixed?: boolean | null
          fixed_at?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "issues_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "issues_scan_id_fkey"
            columns: ["scan_id"]
            isOneToOne: false
            referencedRelation: "scans"
            referencedColumns: ["id"]
          },
        ]
      }
      keywords: {
        Row: {
          id: string
          project_id: string
          keyword: string
          search_volume: number | null
          difficulty: number | null
          current_ranking: number | null
          target_page_id: string | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          keyword: string
          search_volume?: number | null
          difficulty?: number | null
          current_ranking?: number | null
          target_page_id?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          keyword?: string
          search_volume?: number | null
          difficulty?: number | null
          current_ranking?: number | null
          target_page_id?: string | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "keywords_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "keywords_target_page_id_fkey"
            columns: ["target_page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      paddle_webhooks: {
        Row: {
          id: string
          event_id: string
          event_type: string
          payload: Json
          processed_at: string | null
        }
        Insert: {
          id?: string
          event_id: string
          event_type: string
          payload: Json
          processed_at?: string | null
        }
        Update: {
          id?: string
          event_id?: string
          event_type?: string
          payload?: Json
          processed_at?: string | null
        }
        Relationships: []
      }
      page_links: {
        Row: {
          id: string
          project_id: string
          source_page_id: string
          destination_url: string
          destination_page_id: string | null
          anchor_text: string | null
          link_type: string
          is_followed: boolean | null
          is_broken: boolean | null
          http_status: number | null
          rel_attributes: Json | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          source_page_id: string
          destination_url: string
          destination_page_id?: string | null
          anchor_text?: string | null
          link_type: string
          is_followed?: boolean | null
          is_broken?: boolean | null
          http_status?: number | null
          rel_attributes?: Json | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          source_page_id?: string
          destination_url?: string
          destination_page_id?: string | null
          anchor_text?: string | null
          link_type?: string
          is_followed?: boolean | null
          is_broken?: boolean | null
          http_status?: number | null
          rel_attributes?: Json | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "page_links_destination_page_id_fkey"
            columns: ["destination_page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "page_links_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "page_links_source_page_id_fkey"
            columns: ["source_page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
        ]
      }
      pages: {
        Row: {
          id: string
          project_id: string
          url: string
          title: string | null
          meta_description: string | null
          meta_description_length: number | null
          title_length: number | null
          h1s: Json | null
          h2s: Json | null
          h3s: Json | null
          h4s: Json | null
          h5s: Json | null
          h6s: Json | null
          content_length: number | null
          word_count: number | null
          open_graph: Json | null
          twitter_card: Json | null
          canonical_url: string | null
          http_status: number | null
          is_indexable: boolean | null
          has_robots_noindex: boolean | null
          has_robots_nofollow: boolean | null
          depth: number | null
          crawl_priority: number | null
          redirect_url: string | null
          content_type: string | null
          size_bytes: number | null
          load_time_ms: number | null
          first_byte_time_ms: number | null
          structured_data: Json | null
          schema_types: Json | null
          images: Json | null
          keywords: Json | null
          js_count: number | null
          css_count: number | null
          created_at: string | null
          updated_at: string | null
          security_headers: Json | null
          redirect_chain: Json | null
          has_viewport_meta: boolean | null
          has_mixed_content: boolean | null
          heading_hierarchy_valid: boolean | null
          heading_hierarchy_issues: Json | null
          hreflang_tags: Json | null
          canonical_is_self: boolean | null
          url_issues: Json | null
          content_hash: string | null
          readability_score: number | null
        }
        Insert: {
          id?: string
          project_id: string
          url: string
          title?: string | null
          meta_description?: string | null
          meta_description_length?: number | null
          title_length?: number | null
          h1s?: Json | null
          h2s?: Json | null
          h3s?: Json | null
          h4s?: Json | null
          h5s?: Json | null
          h6s?: Json | null
          content_length?: number | null
          word_count?: number | null
          open_graph?: Json | null
          twitter_card?: Json | null
          canonical_url?: string | null
          http_status?: number | null
          is_indexable?: boolean | null
          has_robots_noindex?: boolean | null
          has_robots_nofollow?: boolean | null
          depth?: number | null
          crawl_priority?: number | null
          redirect_url?: string | null
          content_type?: string | null
          size_bytes?: number | null
          load_time_ms?: number | null
          first_byte_time_ms?: number | null
          structured_data?: Json | null
          schema_types?: Json | null
          images?: Json | null
          keywords?: Json | null
          js_count?: number | null
          css_count?: number | null
          created_at?: string | null
          updated_at?: string | null
          security_headers?: Json | null
          redirect_chain?: Json | null
          has_viewport_meta?: boolean | null
          has_mixed_content?: boolean | null
          heading_hierarchy_valid?: boolean | null
          heading_hierarchy_issues?: Json | null
          hreflang_tags?: Json | null
          canonical_is_self?: boolean | null
          url_issues?: Json | null
          content_hash?: string | null
          readability_score?: number | null
        }
        Update: {
          id?: string
          project_id?: string
          url?: string
          title?: string | null
          meta_description?: string | null
          meta_description_length?: number | null
          title_length?: number | null
          h1s?: Json | null
          h2s?: Json | null
          h3s?: Json | null
          h4s?: Json | null
          h5s?: Json | null
          h6s?: Json | null
          content_length?: number | null
          word_count?: number | null
          open_graph?: Json | null
          twitter_card?: Json | null
          canonical_url?: string | null
          http_status?: number | null
          is_indexable?: boolean | null
          has_robots_noindex?: boolean | null
          has_robots_nofollow?: boolean | null
          depth?: number | null
          crawl_priority?: number | null
          redirect_url?: string | null
          content_type?: string | null
          size_bytes?: number | null
          load_time_ms?: number | null
          first_byte_time_ms?: number | null
          structured_data?: Json | null
          schema_types?: Json | null
          images?: Json | null
          keywords?: Json | null
          js_count?: number | null
          css_count?: number | null
          created_at?: string | null
          updated_at?: string | null
          security_headers?: Json | null
          redirect_chain?: Json | null
          has_viewport_meta?: boolean | null
          has_mixed_content?: boolean | null
          heading_hierarchy_valid?: boolean | null
          heading_hierarchy_issues?: Json | null
          hreflang_tags?: Json | null
          canonical_is_self?: boolean | null
          url_issues?: Json | null
          content_hash?: string | null
          readability_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pages_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          id: string
          email: string | null
          full_name: string | null
          avatar_url: string | null
          paddle_customer_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          settings: Json | null
          created_at: string | null
          updated_at: string | null
          paddle_subscription_id: string | null
          subscription_period_end: string | null
        }
        Insert: {
          id: string
          email?: string | null
          full_name?: string | null
          avatar_url?: string | null
          paddle_customer_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          settings?: Json | null
          created_at?: string | null
          updated_at?: string | null
          paddle_subscription_id?: string | null
          subscription_period_end?: string | null
        }
        Update: {
          id?: string
          email?: string | null
          full_name?: string | null
          avatar_url?: string | null
          paddle_customer_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          settings?: Json | null
          created_at?: string | null
          updated_at?: string | null
          paddle_subscription_id?: string | null
          subscription_period_end?: string | null
        }
        Relationships: []
      }
      projects: {
        Row: {
          id: string
          user_id: string | null
          name: string
          url: string
          description: string | null
          scan_frequency: string | null
          last_scan_at: string | null
          next_scan_at: string | null
          created_at: string | null
          updated_at: string | null
          settings: Json | null
          notification_email: string | null
          project_type: string | null
          deleted_at: string | null
        }
        Insert: {
          id?: string
          user_id?: string | null
          name: string
          url: string
          description?: string | null
          scan_frequency?: string | null
          last_scan_at?: string | null
          next_scan_at?: string | null
          created_at?: string | null
          updated_at?: string | null
          settings?: Json | null
          notification_email?: string | null
          project_type?: string | null
          deleted_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string | null
          name?: string
          url?: string
          description?: string | null
          scan_frequency?: string | null
          last_scan_at?: string | null
          next_scan_at?: string | null
          created_at?: string | null
          updated_at?: string | null
          settings?: Json | null
          notification_email?: string | null
          project_type?: string | null
          deleted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "projects_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      scan_snapshots: {
        Row: {
          id: string
          scan_id: string
          snapshot_data: Json
          created_at: string | null
        }
        Insert: {
          id?: string
          scan_id: string
          snapshot_data: Json
          created_at?: string | null
        }
        Update: {
          id?: string
          scan_id?: string
          snapshot_data?: Json
          created_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scan_snapshots_scan_id_fkey"
            columns: ["scan_id"]
            isOneToOne: false
            referencedRelation: "scans"
            referencedColumns: ["id"]
          },
        ]
      }
      scans: {
        Row: {
          id: string
          project_id: string
          started_at: string | null
          completed_at: string | null
          status: string | null
          pages_scanned: number | null
          links_scanned: number | null
          issues_found: number | null
          summary_stats: Json | null
          created_at: string | null
          updated_at: string | null
          last_progress_update: string | null
          scan_type: string | null
        }
        Insert: {
          id?: string
          project_id: string
          started_at?: string | null
          completed_at?: string | null
          status?: string | null
          pages_scanned?: number | null
          links_scanned?: number | null
          issues_found?: number | null
          summary_stats?: Json | null
          created_at?: string | null
          updated_at?: string | null
          last_progress_update?: string | null
          scan_type?: string | null
        }
        Update: {
          id?: string
          project_id?: string
          started_at?: string | null
          completed_at?: string | null
          status?: string | null
          pages_scanned?: number | null
          links_scanned?: number | null
          issues_found?: number | null
          summary_stats?: Json | null
          created_at?: string | null
          updated_at?: string | null
          last_progress_update?: string | null
          scan_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "scans_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      subscription_plans: {
        Row: {
          id: string
          name: string
          price_monthly: number
          price_yearly: number | null
          paddle_price_id_monthly: string | null
          paddle_price_id_yearly: string | null
          max_projects: number
          max_pages_per_scan: number
          scan_frequency: string
          max_keywords: number
          history_days: number
          max_team_members: number
          max_competitors: number
          features: Json | null
          created_at: string | null
        }
        Insert: {
          id: string
          name: string
          price_monthly: number
          price_yearly?: number | null
          paddle_price_id_monthly?: string | null
          paddle_price_id_yearly?: string | null
          max_projects: number
          max_pages_per_scan: number
          scan_frequency: string
          max_keywords: number
          history_days: number
          max_team_members: number
          max_competitors: number
          features?: Json | null
          created_at?: string | null
        }
        Update: {
          id?: string
          name?: string
          price_monthly?: number
          price_yearly?: number | null
          paddle_price_id_monthly?: string | null
          paddle_price_id_yearly?: string | null
          max_projects?: number
          max_pages_per_scan?: number
          scan_frequency?: string
          max_keywords?: number
          history_days?: number
          max_team_members?: number
          max_competitors?: number
          features?: Json | null
          created_at?: string | null
        }
        Relationships: []
      }
      usage_tracking: {
        Row: {
          id: string
          user_id: string
          period_start: string
          period_end: string
          projects_count: number | null
          scans_performed: number | null
          pages_scanned: number | null
          created_at: string | null
          updated_at: string | null
        }
        Insert: {
          id?: string
          user_id: string
          period_start: string
          period_end: string
          projects_count?: number | null
          scans_performed?: number | null
          pages_scanned?: number | null
          created_at?: string | null
          updated_at?: string | null
        }
        Update: {
          id?: string
          user_id?: string
          period_start?: string
          period_end?: string
          projects_count?: number | null
          scans_performed?: number | null
          pages_scanned?: number | null
          created_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_tracking_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
    }
    Functions: {
      get_current_usage: {
        Args: {
          p_user_id: string
        }
        Returns: Json[]
      }
      increment_usage: {
        Args: {
          p_user_id: string
          p_scans: number
          p_pages: number
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
