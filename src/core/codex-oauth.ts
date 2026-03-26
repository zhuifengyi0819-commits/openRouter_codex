export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];

export function buildCodexAuthorizeExtraParams(forceLoginPrompt: boolean): Record<string, string> {
  const params: Record<string, string> = {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "pi"
  };

  if (forceLoginPrompt) {
    params.prompt = "login";
    params.max_age = "0";
  }

  return params;
}
