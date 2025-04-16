export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      backlinks: {
        Row: {
          anchor_text: string | null
          created_at: string | null
          domain_authority: number | null
          first_seen_at: string | null
          id: string
          is_followed: boolean | null
          last_seen_at: string | null
          page_id: string | null
          project_id: string
          source_domain: string
          source_url: string
          updated_at: string | null
        }
        Insert: {
          anchor_text?: string | null
          created_at?: string | null
          domain_authority?: number | null
          first_seen_at?: string | null
          id?: string
          is_followed?: boolean | null
          last_seen_at?: string | null
          page_id?: string | null
          project_id: string
          source_domain: string
          source_url: string
          updated_at?: string | null
        }
        Update: {
          anchor_text?: string | null
          created_at?: string | null
          domain_authority?: number | null
          first_seen_at?: string | null
          id?: string
          is_followed?: boolean | null
          last_seen_at?: string | null
          page_id?: string | null
          project_id?: string
          source_domain?: string
          source_url?: string
          updated_at?: string | null
        }
        Relationships: [
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
          created_at: string | null
          domain: string
          id: string
          notes: string | null
          project_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          domain: string
          id?: string
          notes?: string | null
          project_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          domain?: string
          id?: string
          notes?: string | null
          project_id?: string
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
          created_at: string | null
          description: string
          details: Json | null
          fixed_at: string | null
          id: string
          is_fixed: boolean | null
          issue_type: string
          page_id: string
          project_id: string
          scan_id: string
          severity: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          description: string
          details?: Json | null
          fixed_at?: string | null
          id?: string
          is_fixed?: boolean | null
          issue_type: string
          page_id: string
          project_id: string
          scan_id: string
          severity: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string
          details?: Json | null
          fixed_at?: string | null
          id?: string
          is_fixed?: boolean | null
          issue_type?: string
          page_id?: string
          project_id?: string
          scan_id?: string
          severity?: string
          updated_at?: string | null
        }
        Relationships: [
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
          created_at: string | null
          current_ranking: number | null
          difficulty: number | null
          id: string
          keyword: string
          project_id: string
          search_volume: number | null
          target_page_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          current_ranking?: number | null
          difficulty?: number | null
          id?: string
          keyword: string
          project_id: string
          search_volume?: number | null
          target_page_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          current_ranking?: number | null
          difficulty?: number | null
          id?: string
          keyword?: string
          project_id?: string
          search_volume?: number | null
          target_page_id?: string | null
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
        ]
      }
      page_links: {
        Row: {
          anchor_text: string | null
          created_at: string | null
          destination_page_id: string | null
          destination_url: string
          http_status: number | null
          id: string
          is_broken: boolean | null
          is_followed: boolean | null
          link_type: string
          project_id: string
          source_page_id: string
          updated_at: string | null
        }
        Insert: {
          anchor_text?: string | null
          created_at?: string | null
          destination_page_id?: string | null
          destination_url: string
          http_status?: number | null
          id?: string
          is_broken?: boolean | null
          is_followed?: boolean | null
          link_type: string
          project_id: string
          source_page_id: string
          updated_at?: string | null
        }
        Update: {
          anchor_text?: string | null
          created_at?: string | null
          destination_page_id?: string | null
          destination_url?: string
          http_status?: number | null
          id?: string
          is_broken?: boolean | null
          is_followed?: boolean | null
          link_type?: string
          project_id?: string
          source_page_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "page_links_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      pages: {
        Row: {
          canonical_url: string | null
          content_length: number | null
          content_type: string | null
          crawl_priority: number | null
          created_at: string | null
          css_count: number | null
          depth: number | null
          first_byte_time_ms: number | null
          h1s: Json | null
          h2s: Json | null
          h3s: Json | null
          has_robots_nofollow: boolean | null
          has_robots_noindex: boolean | null
          http_status: number | null
          id: string
          image_count: number | null
          is_indexable: boolean | null
          js_count: number | null
          load_time_ms: number | null
          meta_description: string | null
          open_graph: Json | null
          project_id: string
          redirect_url: string | null
          size_bytes: number | null
          structured_data: Json | null
          title: string | null
          twitter_card: Json | null
          updated_at: string | null
          url: string
        }
        Insert: {
          canonical_url?: string | null
          content_length?: number | null
          content_type?: string | null
          crawl_priority?: number | null
          created_at?: string | null
          css_count?: number | null
          depth?: number | null
          first_byte_time_ms?: number | null
          h1s?: Json | null
          h2s?: Json | null
          h3s?: Json | null
          has_robots_nofollow?: boolean | null
          has_robots_noindex?: boolean | null
          http_status?: number | null
          id?: string
          image_count?: number | null
          is_indexable?: boolean | null
          js_count?: number | null
          load_time_ms?: number | null
          meta_description?: string | null
          open_graph?: Json | null
          project_id: string
          redirect_url?: string | null
          size_bytes?: number | null
          structured_data?: Json | null
          title?: string | null
          twitter_card?: Json | null
          updated_at?: string | null
          url: string
        }
        Update: {
          canonical_url?: string | null
          content_length?: number | null
          content_type?: string | null
          crawl_priority?: number | null
          created_at?: string | null
          css_count?: number | null
          depth?: number | null
          first_byte_time_ms?: number | null
          h1s?: Json | null
          h2s?: Json | null
          h3s?: Json | null
          has_robots_nofollow?: boolean | null
          has_robots_noindex?: boolean | null
          http_status?: number | null
          id?: string
          image_count?: number | null
          is_indexable?: boolean | null
          js_count?: number | null
          load_time_ms?: number | null
          meta_description?: string | null
          open_graph?: Json | null
          project_id?: string
          redirect_url?: string | null
          size_bytes?: number | null
          structured_data?: Json | null
          title?: string | null
          twitter_card?: Json | null
          updated_at?: string | null
          url?: string
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
          avatar_url: string | null
          created_at: string | null
          email: string | null
          full_name: string | null
          id: string
          settings: Json | null
          stripe_customer_id: string | null
          subscription_status: string | null
          subscription_tier: string | null
          updated_at: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          settings?: Json | null
          stripe_customer_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          updated_at?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          settings?: Json | null
          stripe_customer_id?: string | null
          subscription_status?: string | null
          subscription_tier?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_at: string | null
          description: string | null
          id: string
          last_scan_at: string | null
          name: string
          notification_email: string | null
          robots_txt: Json | null
          scan_frequency: string | null
          settings: Json | null
          updated_at: string | null
          url: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          id?: string
          last_scan_at?: string | null
          name: string
          notification_email?: string | null
          robots_txt?: Json | null
          scan_frequency?: string | null
          settings?: Json | null
          updated_at?: string | null
          url: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          id?: string
          last_scan_at?: string | null
          name?: string
          notification_email?: string | null
          robots_txt?: Json | null
          scan_frequency?: string | null
          settings?: Json | null
          updated_at?: string | null
          url?: string
          user_id?: string
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
      scan_page_snapshots: {
        Row: {
          content_length: number | null
          created_at: string | null
          h1s: Json | null
          h2s: Json | null
          h3s: Json | null
          http_status: number | null
          id: string
          is_indexable: boolean | null
          issues: Json | null
          meta_description: string | null
          page_id: string
          scan_id: string
          snapshot_data: Json | null
          title: string | null
          url: string
        }
        Insert: {
          content_length?: number | null
          created_at?: string | null
          h1s?: Json | null
          h2s?: Json | null
          h3s?: Json | null
          http_status?: number | null
          id?: string
          is_indexable?: boolean | null
          issues?: Json | null
          meta_description?: string | null
          page_id: string
          scan_id: string
          snapshot_data?: Json | null
          title?: string | null
          url: string
        }
        Update: {
          content_length?: number | null
          created_at?: string | null
          h1s?: Json | null
          h2s?: Json | null
          h3s?: Json | null
          http_status?: number | null
          id?: string
          is_indexable?: boolean | null
          issues?: Json | null
          meta_description?: string | null
          page_id?: string
          scan_id?: string
          snapshot_data?: Json | null
          title?: string | null
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "scan_page_snapshots_page_id_fkey"
            columns: ["page_id"]
            isOneToOne: false
            referencedRelation: "pages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_page_snapshots_scan_id_fkey"
            columns: ["scan_id"]
            isOneToOne: false
            referencedRelation: "scans"
            referencedColumns: ["id"]
          },
        ]
      }
      scans: {
        Row: {
          completed_at: string | null
          created_at: string | null
          id: string
          issues_found: number | null
          links_scanned: number | null
          pages_scanned: number | null
          project_id: string
          queue_position: number | null
          started_at: string | null
          status: string | null
          summary_stats: Json | null
          updated_at: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string | null
          id?: string
          issues_found?: number | null
          links_scanned?: number | null
          pages_scanned?: number | null
          project_id: string
          queue_position?: number | null
          started_at?: string | null
          status?: string | null
          summary_stats?: Json | null
          updated_at?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string | null
          id?: string
          issues_found?: number | null
          links_scanned?: number | null
          pages_scanned?: number | null
          project_id?: string
          queue_position?: number | null
          started_at?: string | null
          status?: string | null
          summary_stats?: Json | null
          updated_at?: string | null
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DefaultSchema = Database[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? (Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      Database[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
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
    | { schema: keyof Database },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof Database }
  ? Database[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof Database },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof Database
  }
    ? keyof Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof Database }
  ? Database[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
