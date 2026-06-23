export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      jmdict_entries: {
        Row: {
          entry_id: string
        }
        Insert: {
          entry_id: string
        }
        Update: {
          entry_id?: string
        }
        Relationships: []
      }
      jmdict_glosses: {
        Row: {
          id: number
          lang: string
          position: number
          sense_id: number
          text: string
        }
        Insert: {
          id?: number
          lang?: string
          position: number
          sense_id: number
          text: string
        }
        Update: {
          id?: number
          lang?: string
          position?: number
          sense_id?: number
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "jmdict_glosses_sense_id_fkey"
            columns: ["sense_id"]
            isOneToOne: false
            referencedRelation: "jmdict_senses"
            referencedColumns: ["id"]
          },
        ]
      }
      jmdict_kana: {
        Row: {
          applies_to_kanji: string[]
          common: boolean
          entry_id: string
          frequency: number | null
          id: number
          position: number
          text: string
        }
        Insert: {
          applies_to_kanji?: string[]
          common?: boolean
          entry_id: string
          frequency?: number | null
          id?: number
          position: number
          text: string
        }
        Update: {
          applies_to_kanji?: string[]
          common?: boolean
          entry_id?: string
          frequency?: number | null
          id?: number
          position?: number
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "jmdict_kana_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "jmdict_entries"
            referencedColumns: ["entry_id"]
          },
        ]
      }
      jmdict_kanji: {
        Row: {
          common: boolean
          entry_id: string
          frequency: number | null
          id: number
          position: number
          text: string
        }
        Insert: {
          common?: boolean
          entry_id: string
          frequency?: number | null
          id?: number
          position: number
          text: string
        }
        Update: {
          common?: boolean
          entry_id?: string
          frequency?: number | null
          id?: number
          position?: number
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "jmdict_kanji_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "jmdict_entries"
            referencedColumns: ["entry_id"]
          },
        ]
      }
      jmdict_senses: {
        Row: {
          applies_to_kana: string[]
          applies_to_kanji: string[]
          entry_id: string
          id: number
          part_of_speech: string[]
          position: number
          usually_kana: boolean
        }
        Insert: {
          applies_to_kana?: string[]
          applies_to_kanji?: string[]
          entry_id: string
          id?: number
          part_of_speech?: string[]
          position: number
          usually_kana?: boolean
        }
        Update: {
          applies_to_kana?: string[]
          applies_to_kanji?: string[]
          entry_id?: string
          id?: number
          part_of_speech?: string[]
          position?: number
          usually_kana?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "jmdict_senses_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "jmdict_entries"
            referencedColumns: ["entry_id"]
          },
        ]
      }
      list_words: {
        Row: {
          list_id: string
          list_word_id: string
          user_word_id: string
        }
        Insert: {
          list_id: string
          list_word_id?: string
          user_word_id: string
        }
        Update: {
          list_id?: string
          list_word_id?: string
          user_word_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "list_words_list_id_fkey"
            columns: ["list_id"]
            isOneToOne: false
            referencedRelation: "lists"
            referencedColumns: ["list_id"]
          },
          {
            foreignKeyName: "list_words_user_word_id_fkey"
            columns: ["user_word_id"]
            isOneToOne: false
            referencedRelation: "user_words"
            referencedColumns: ["user_word_id"]
          },
        ]
      }
      lists: {
        Row: {
          list_id: string
          list_name: string
          user_id: string
        }
        Insert: {
          list_id?: string
          list_name: string
          user_id: string
        }
        Update: {
          list_id?: string
          list_name?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lists_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      review_log: {
        Row: {
          elapsed_days: number | null
          grade: number
          log_id: string
          new_stability: number
          prev_stability: number | null
          reviewed_at: string
          user_id: string
          user_word_id: string
        }
        Insert: {
          elapsed_days?: number | null
          grade: number
          log_id?: string
          new_stability: number
          prev_stability?: number | null
          reviewed_at?: string
          user_id: string
          user_word_id: string
        }
        Update: {
          elapsed_days?: number | null
          grade?: number
          log_id?: string
          new_stability?: number
          prev_stability?: number | null
          reviewed_at?: string
          user_id?: string
          user_word_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "review_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
          {
            foreignKeyName: "review_log_user_word_id_fkey"
            columns: ["user_word_id"]
            isOneToOne: false
            referencedRelation: "user_words"
            referencedColumns: ["user_word_id"]
          },
        ]
      }
      translation_usage: {
        Row: {
          chars_used: number
          period_month: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chars_used?: number
          period_month: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chars_used?: number
          period_month?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "translation_usage_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_limits: {
        Row: {
          monthly_char_quota: number | null
          paragraph_char_limit: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          monthly_char_quota?: number | null
          paragraph_char_limit?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          monthly_char_quota?: number | null
          paragraph_char_limit?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_limits_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      user_words: {
        Row: {
          confidence_rating: number
          custom_translation: string | null
          dictionary_word_id: string | null
          input: string
          last_reviewed_date: string | null
          originally_translated_date: string
          source_lang: string
          stability: number | null
          target_lang: string
          user_id: string
          user_word_id: string
        }
        Insert: {
          confidence_rating?: number
          custom_translation?: string | null
          dictionary_word_id?: string | null
          input: string
          last_reviewed_date?: string | null
          originally_translated_date?: string
          source_lang: string
          stability?: number | null
          target_lang: string
          user_id: string
          user_word_id?: string
        }
        Update: {
          confidence_rating?: number
          custom_translation?: string | null
          dictionary_word_id?: string | null
          input?: string
          last_reviewed_date?: string | null
          originally_translated_date?: string
          source_lang?: string
          stability?: number | null
          target_lang?: string
          user_id?: string
          user_word_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_words_dictionary_word_id_fkey"
            columns: ["dictionary_word_id"]
            isOneToOne: false
            referencedRelation: "words"
            referencedColumns: ["word_id"]
          },
          {
            foreignKeyName: "user_words_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["user_id"]
          },
        ]
      }
      users: {
        Row: {
          date_created: string
          email: string
          level: number | null
          user_id: string
        }
        Insert: {
          date_created?: string
          email: string
          level?: number | null
          user_id: string
        }
        Update: {
          date_created?: string
          email?: string
          level?: number | null
          user_id?: string
        }
        Relationships: []
      }
      words: {
        Row: {
          dictionary_ref: string | null
          difficulty_override: number | null
          frequency: number | null
          input: string
          input_reading: string | null
          is_verified: boolean
          jmdict_entry_id: string | null
          jmdict_sense_pos: number | null
          part_of_speech: string[] | null
          projection_version: number
          source_lang: string
          target_lang: string
          translation: string
          translation_reading: string | null
          word_id: string
        }
        Insert: {
          dictionary_ref?: string | null
          difficulty_override?: number | null
          frequency?: number | null
          input: string
          input_reading?: string | null
          is_verified?: boolean
          jmdict_entry_id?: string | null
          jmdict_sense_pos?: number | null
          part_of_speech?: string[] | null
          projection_version?: number
          source_lang: string
          target_lang: string
          translation: string
          translation_reading?: string | null
          word_id?: string
        }
        Update: {
          dictionary_ref?: string | null
          difficulty_override?: number | null
          frequency?: number | null
          input?: string
          input_reading?: string | null
          is_verified?: boolean
          jmdict_entry_id?: string | null
          jmdict_sense_pos?: number | null
          part_of_speech?: string[] | null
          projection_version?: number
          source_lang?: string
          target_lang?: string
          translation?: string
          translation_reading?: string | null
          word_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      consume_translation_quota: {
        Args: { p_chars: number; p_quota: number; p_user_id: string }
        Returns: {
          allowed: boolean
          used: number
        }[]
      }
      create_custom_word: {
        Args: {
          p_input: string
          p_list_id?: string
          p_source: string
          p_target: string
          p_translation: string
          p_user_id: string
        }
        Returns: {
          confidence_rating: number
          custom_translation: string | null
          dictionary_word_id: string | null
          input: string
          last_reviewed_date: string | null
          originally_translated_date: string
          source_lang: string
          stability: number | null
          target_lang: string
          user_id: string
          user_word_id: string
        }
        SetofOptions: {
          from: "*"
          to: "user_words"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      jmdict_lookup: {
        Args: { p_input: string; p_source: string; p_target: string }
        Returns: {
          frequency: number
          input_reading: string
          jmdict_entry_id: string
          part_of_speech: string[]
          sense_position: number
          translation: string
          translation_reading: string
          writing: string
        }[]
      }
      related_words: {
        Args: { p_entry_id: string; p_limit?: number }
        Returns: {
          entry_id: string
          writing: string | null
          gloss: string | null
          distance: number
        }[]
      }
      record_review: {
        Args: { p_grade: number; p_user_word_id: string }
        Returns: {
          confidence_rating: number
          custom_translation: string | null
          dictionary_word_id: string | null
          input: string
          last_reviewed_date: string | null
          originally_translated_date: string
          source_lang: string
          stability: number | null
          target_lang: string
          user_id: string
          user_word_id: string
        }
        SetofOptions: {
          from: "*"
          to: "user_words"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_dictionary_word: {
        Args: {
          p_dictionary_word_id: string
          p_initial_stability?: number
          p_list_id?: string
          p_user_id: string
        }
        Returns: {
          confidence_rating: number
          custom_translation: string | null
          dictionary_word_id: string | null
          input: string
          last_reviewed_date: string | null
          originally_translated_date: string
          source_lang: string
          stability: number | null
          target_lang: string
          user_id: string
          user_word_id: string
        }
        SetofOptions: {
          from: "*"
          to: "user_words"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_dictionary_words: {
        Args: {
          p_dictionary_word_ids: string[]
          p_initial_stabilities?: (number | null)[]
          p_list_id?: string
          p_user_id: string
        }
        Returns: {
          confidence_rating: number
          custom_translation: string | null
          dictionary_word_id: string | null
          input: string
          last_reviewed_date: string | null
          originally_translated_date: string
          source_lang: string
          stability: number | null
          target_lang: string
          user_id: string
          user_word_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "user_words"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      review_queue: {
        Args: { p_limit: number; p_list_id?: string; p_user_id: string }
        Returns: {
          confidence_rating: number
          custom_translation: string | null
          dictionary_word_id: string | null
          input: string
          input_reading: string | null
          last_reviewed_date: string | null
          originally_translated_date: string
          retrievability: number
          source_lang: string
          stability: number | null
          target_lang: string
          translation: string
          translation_reading: string | null
          user_id: string
          user_word_id: string
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

