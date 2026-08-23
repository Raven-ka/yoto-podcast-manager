//! Safe episode downloader (SPEC.md §7).
//! Redirect-hop revalidation, private-IP (SSRF) guard, byte ceiling,
//! streaming SHA-256, atomic move into place.

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, ToSocketAddrs};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use url::Url;

const MAX_REDIRECTS: usize = 5;
const CONNECT_TIMEOUT_S: u64 = 20;
const READ_TIMEOUT_S: u64 = 120;

#[derive(Serialize)]
pub struct DownloadResult {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub final_url: String,
    pub content_type: Option<String>,
    pub redirect_chain: Vec<String>,
}

fn ip_is_forbidden(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                // AWS/GCP metadata service
                || v4.octets() == [169, 254, 169, 254]
                // CGNAT 100.64.0.0/10
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // unique-local fc00::/7
                || (v6.segments()[0] & 0xFE00) == 0xFC00
                // link-local fe80::/10
                || (v6.segments()[0] & 0xFFC0) == 0xFE80
        }
    }
}

/// Resolve the host and reject any URL whose host maps to a private/internal IP.
fn validate_url(u: &Url, allow_http: bool) -> Result<(), String> {
    match u.scheme() {
        "https" => {}
        "http" if allow_http => {}
        s => return Err(format!("blocked scheme '{s}' (E_URL_SCHEME)")),
    }
    let host = u.host_str().ok_or("missing host (E_URL_HOST)")?;
    let port = u.port_or_known_default().unwrap_or(443);
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("DNS failed for {host}: {e} (E_DNS)"))?;
    let mut any = false;
    for a in addrs {
        any = true;
        if ip_is_forbidden(&a.ip()) {
            return Err(format!("host {host} resolves to a private address (E_SSRF)"));
        }
    }
    if !any {
        return Err(format!("no addresses for {host} (E_DNS)"));
    }
    Ok(())
}

/// Download `url` to `dest_dir/<tmp>` then rename to `dest_dir/<sha256><ext>`.
/// `allow_http` permits an explicit per-source HTTPS→HTTP downgrade opt-in.
#[tauri::command]
pub async fn download_file(
    url: String,
    dest_dir: String,
    max_bytes: u64,
    allow_http: bool,
) -> Result<DownloadResult, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_S))
        .read_timeout(std::time::Duration::from_secs(READ_TIMEOUT_S))
        .user_agent("YotoPodcastManager/0.1 (personal use)")
        .build()
        .map_err(|e| e.to_string())?;

    // Follow redirects manually so every hop is revalidated.
    let mut current = Url::parse(&url).map_err(|e| format!("bad URL: {e} (E_URL)"))?;
    let started_https = current.scheme() == "https";
    let mut chain: Vec<String> = vec![];
    let mut response = None;
    for _hop in 0..=MAX_REDIRECTS {
        validate_url(&current, allow_http)?;
        if started_https && current.scheme() == "http" && !allow_http {
            return Err("HTTPS→HTTP downgrade blocked (E_DOWNGRADE)".into());
        }
        let resp = client
            .get(current.clone())
            .send()
            .await
            .map_err(|e| format!("request failed: {e} (E_NET)"))?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("redirect without Location (E_REDIRECT)")?;
            let next = current
                .join(loc)
                .map_err(|e| format!("bad redirect target: {e} (E_REDIRECT)"))?;
            chain.push(next.to_string());
            if chain.len() > MAX_REDIRECTS {
                return Err("too many redirects (E_REDIRECT_MAX)".into());
            }
            current = next;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {} (E_HTTP_STATUS)", resp.status()));
        }
        response = Some(resp);
        break;
    }
    let resp = response.ok_or("too many redirects (E_REDIRECT_MAX)")?;
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // Stream to temp file with byte ceiling + running SHA-256.
    let dir = PathBuf::from(&dest_dir);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("mkdir: {e} (E_FS)"))?;
    let tmp = dir.join(format!(".part-{}", std::process::id()));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| format!("create: {e} (E_FS)"))?;
    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("read: {e} (E_NET)"))?;
        total += chunk.len() as u64;
        if total > max_bytes {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(format!("exceeded byte ceiling {max_bytes} (E_TOO_BIG)"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("write: {e} (E_FS)"))?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    drop(file);

    let sha = hex::encode(hasher.finalize());
    let ext = current
        .path()
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 4 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_default();
    let final_path = dir.join(format!("{sha}{ext}"));
    tokio::fs::rename(&tmp, &final_path)
        .await
        .map_err(|e| format!("rename: {e} (E_FS)"))?;

    Ok(DownloadResult {
        path: final_path.to_string_lossy().to_string(),
        bytes: total,
        sha256: sha,
        final_url: current.to_string(),
        content_type,
        redirect_chain: chain,
    })
}
