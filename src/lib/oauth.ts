// OAuth 2.0 Authorization Code + PKCE for a public client (SPEC.md §5, §13).
// Flow: open system browser → user signs in at Yoto → browser redirects to
// yotopm://oauth/callback → deep-link plugin hands the URL back → exchange code.
// Tokens live in the OS keychain via the Rust `secret_*` commands.
import { invoke } from "@tauri-apps/api/core";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetch } from "@tauri-apps/plugin-http";
import {
  OAUTH_CALLBACK,
  OAUTH_SCOPES,
  YOTO_AUDIENCE,
  YOTO_AUTH_DOMAIN,
  YOTO_CLIENT_ID,
} from "../config";

const KEY_REFRESH = "yoto_refresh_token";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${YOTO_AUTH_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token endpoint returned ${res.status} (E_AUTH_TOKEN)`);
  }
  return (await res.json()) as TokenResponse;
}

async function storeTokens(t: TokenResponse): Promise<void> {
  accessToken = t.access_token;
  accessTokenExpiresAt = Date.now() + (t.expires_in - 60) * 1000;
  if (t.refresh_token) {
    await invoke("secret_set", { key: KEY_REFRESH, value: t.refresh_token });
  }
}

/** Launch the browser sign-in and resolve when the deep-link callback lands. */
export async function signIn(): Promise<void> {
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));

  const code = await new Promise<string>(async (resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Sign-in timed out (E_AUTH_TIMEOUT)")),
      5 * 60 * 1000,
    );
    const unlisten = await onOpenUrl((urls) => {
      for (const u of urls) {
        const parsed = new URL(u);
        if (!u.startsWith(OAUTH_CALLBACK)) continue;
        if (parsed.searchParams.get("state") !== state) {
          reject(new Error("State mismatch (E_AUTH_STATE)"));
        } else if (parsed.searchParams.get("error")) {
          reject(new Error(parsed.searchParams.get("error_description") ?? "Sign-in was cancelled"));
        } else {
          resolve(parsed.searchParams.get("code")!);
        }
        clearTimeout(timeout);
        unlisten();
      }
    });
    const auth = new URL(`${YOTO_AUTH_DOMAIN}/authorize`);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: YOTO_CLIENT_ID,
      redirect_uri: OAUTH_CALLBACK,
      scope: OAUTH_SCOPES,
      audience: YOTO_AUDIENCE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    await openUrl(auth.toString());
  });

  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: YOTO_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: OAUTH_CALLBACK,
  });
  await storeTokens(tokens);
}

/** Valid access token, refreshing via the keychain refresh token if needed. */
export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiresAt) return accessToken;
  const refresh = (await invoke<string | null>("secret_get", { key: KEY_REFRESH }));
  if (!refresh) throw new Error("Not signed in (E_AUTH_NONE)");
  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    client_id: YOTO_CLIENT_ID,
    refresh_token: refresh,
  });
  await storeTokens(tokens);
  return accessToken!;
}

export async function isSignedIn(): Promise<boolean> {
  return (await invoke<string | null>("secret_get", { key: KEY_REFRESH })) != null;
}

export async function signOut(): Promise<void> {
  accessToken = null;
  await invoke("secret_delete", { key: KEY_REFRESH });
}
