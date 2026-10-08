export interface UserRow {
  id: string;
  authentik_sub: string;
  email: string | null;
  name: string;
  role: string;
  jellyfin_user_id: string;
  jellyfin_username: string;
  jellyfin_pw_enc: string;
  seerr_user_id: number | null;
  disabled: boolean;
  created_at: Date;
}
