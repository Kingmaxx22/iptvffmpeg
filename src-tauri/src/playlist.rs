//! M3U parsing for the iptv-org playlist.
//!
//! The upstream file is ~2.5 MB / 23k lines. We parse it once in the backend so
//! the webview never has to deal with playlist CORS or a 2.5 MB download on boot.

use serde::{Deserialize, Serialize};

pub const DEFAULT_PLAYLIST_URL: &str = "https://iptv-org.github.io/iptv/index.m3u";

/// Channels whose `tvg-id` starts with one of these prefixes are surfaced in the
/// "Starter" tab. These were verified end-to-end (playlist -> ffmpeg -> H.264
/// transport stream) while building the player, so the very first launch always
/// has something that plays. Health probing still gates auto-play.
const STARTER_TVG_PREFIXES: &[&str] = &[
    "3abn",
    "3cat",
    "3hd.",
    "123tv",
    "1plus1",
    "2plus2",
    "1kzn",
    "1almere",
    "2x2.ru",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    /// Stable id derived from the stream URL.
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    pub group: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tvg_id: Option<String>,
    /// Playlist-supplied User-Agent; many streams 403 without it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub referrer: Option<String>,
    /// "4K" | "FHD" | "HD" | "SD" | "LD" derived from the channel name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    pub featured: bool,
}

#[derive(Debug, Default)]
struct Pending {
    attrs: Vec<(String, String)>,
    name: String,
    user_agent: Option<String>,
    referrer: Option<String>,
}

/// Parse a raw M3U document into channels.
pub fn parse_m3u(text: &str) -> Vec<Channel> {
    let mut out: Vec<Channel> = Vec::with_capacity(12_000);
    let mut pending: Option<Pending> = None;

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            pending = Some(parse_extinf(rest));
            continue;
        }

        // Per-URL options apply to the stream line that follows them.
        if let Some(rest) = line.strip_prefix("#EXTVLCOPT:") {
            let (key, value) = match rest.split_once('=') {
                Some((k, v)) => (k.trim(), v.trim()),
                None => continue,
            };
            let p = pending.get_or_insert_with(Pending::default);
            match key {
                "http-user-agent" => p.user_agent = Some(value.to_string()),
                "http-referrer" => p.referrer = Some(value.to_string()),
                _ => {}
            }
            continue;
        }

        if line.starts_with('#') {
            continue;
        }

        // A bare URL line closes the current #EXTINF entry.
        let Some(p) = pending.take() else {
            continue;
        };
        if line.starts_with("rtmp://") || line.starts_with("rtsp://") {
            // ffmpeg handles these fine, but they are rare and often need extra
            // handshake flags; keep them, they still go through the same pipeline.
        }
        out.push(build_channel(line, p));
    }

    out
}

fn parse_extinf(rest: &str) -> Pending {
    let mut p = Pending::default();
    // `#EXTINF:<duration> <attrs>,<name>` — the leading duration is not an
    // attribute and would otherwise abort the scan before the first one.
    let rest = match rest.trim_start().split_once(' ') {
        Some((head, tail)) if head.parse::<i64>().is_ok() => tail,
        _ => rest.trim_start(),
    };
    // Attributes come first and are all `key="value"` pairs; the display name is
    // whatever follows the first comma that is not inside a quoted value.
    let b = rest.as_bytes();
    let mut i = 0usize;
    let mut last_end = 0usize;
    while i < b.len() {
        while i < b.len() && (b[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] == b',' {
            break;
        }
        let key_start = i;
        while i < b.len() && b[i] != b'=' && b[i] != b',' && !(b[i] as char).is_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] != b'=' {
            break;
        }
        let key = rest[key_start..i].trim().to_ascii_lowercase();
        i += 1; // skip '='
        let value = if i < b.len() && b[i] == b'"' {
            i += 1;
            let v_start = i;
            while i < b.len() && b[i] != b'"' {
                i += 1;
            }
            let v = rest[v_start..i].to_string();
            if i < b.len() {
                i += 1; // skip closing quote
            }
            v
        } else {
            let v_start = i;
            while i < b.len() && b[i] != b',' {
                i += 1;
            }
            rest[v_start..i].trim().to_string()
        };
        last_end = i;
        if !key.is_empty() {
            p.attrs.push((key, value));
        }
    }

    let tail = &rest[last_end..];
    let name = match tail.find(',') {
        // Skip the separator between the attributes and the display name.
        Some(pos) => &rest[last_end + pos + 1..],
        None => rest.get(last_end..).unwrap_or(""),
    };
    p.name = name.trim().to_string();
    p
}

fn attr<'a>(p: &'a Pending, key: &str) -> Option<&'a str> {
    p.attrs
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
}

fn build_channel(url: &str, p: Pending) -> Channel {
    // Read every borrowed attribute before consuming the owned fallbacks.
    let tvg_id = attr(&p, "tvg-id").map(str::to_string);
    let user_agent = attr(&p, "http-user-agent").map(str::to_string);
    let referrer = attr(&p, "http-referrer").map(str::to_string);
    let logo = attr(&p, "tvg-logo").map(str::to_string);
    let group = attr(&p, "group-title").unwrap_or("General").to_string();

    let country = attr(&p, "tvg-country")
        .map(|c| c.to_uppercase())
        .or_else(|| country_from_tvg_id(tvg_id.as_deref()));
    let language = attr(&p, "tvg-language").map(str::to_string);
    let user_agent = user_agent.or(p.user_agent);
    let referrer = referrer.or(p.referrer);

    let resolution = resolution_hint(&p.name);
    let featured = tvg_id
        .as_deref()
        .map(|id| {
            let id = id.to_ascii_lowercase();
            STARTER_TVG_PREFIXES.iter().any(|p| id.starts_with(p))
        })
        .unwrap_or(false);

    Channel {
        id: channel_id(url),
        name: p.name,
        url: url.to_string(),
        logo,
        group,
        country,
        language,
        tvg_id,
        user_agent,
        referrer,
        resolution,
        featured,
    }
}

/// FNV-1a keeps ids short and stable without pulling in a hash crate.
fn channel_id(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("c{hash:016x}")
}

/// `3ABNCanada.ca@SD` -> `CA`
fn country_from_tvg_id(tvg_id: Option<&str>) -> Option<String> {
    let id = tvg_id?;
    let head = id.split('@').next().unwrap_or(id);
    let last = head.rsplit('.').next()?.trim();
    if last.len() == 2 && last.chars().all(|c| c.is_ascii_alphabetic()) {
        Some(last.to_ascii_uppercase())
    } else {
        None
    }
}

/// Many iptv-org channel names embed the source resolution, e.g.
/// "1+1 Marafon (1080p)", "DW English (1080i)", "NHK 4K", "Showcase HD".
fn resolution_hint(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();

    // Bare quality words only count as whole tokens, otherwise "WHDTV" and
    // friends would masquerade as HD.
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect();
    for token in &tokens {
        match *token {
            "4k" | "uhd" => return Some("4K".to_string()),
            "fhd" | "1080" | "1080p" | "1080i" => return Some("FHD".to_string()),
            "hd" | "hdtv" | "720" | "720p" | "576" | "576p" => return Some("HD".to_string()),
            "sd" => return Some("SD".to_string()),
            "360" | "360p" | "240" | "240p" | "270" | "270p" => return Some("LD".to_string()),
            _ => {}
        }
    }

    if lower.contains("2160") {
        Some("4K".to_string())
    } else if lower.contains("480") {
        Some("SD".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"#EXTM3U x-tvg-url="https://example.com/guide.xml.gz"
#EXTINF:-1 tvg-id="3ABNCanada.ca@SD" tvg-logo="https://i.imgur.com/U99CsEc.png" group-title="Religious",3ABN Canada (720p)
#EXTVLCOPT:http-user-agent=CustomAgent/1.0
https://example.com/canada/master.m3u8
#EXTINF:-1 tvg-id="Foo.us" group-title="News;General",Foo HD
https://example.com/foo
"#;

    #[test]
    fn parses_attributes_and_metadata() {
        let channels = parse_m3u(SAMPLE);
        assert_eq!(channels.len(), 2);

        let ca = &channels[0];
        assert_eq!(ca.name, "3ABN Canada (720p)");
        assert_eq!(ca.country.as_deref(), Some("CA"));
        assert_eq!(ca.group, "Religious");
        assert_eq!(ca.resolution.as_deref(), Some("HD"));
        assert_eq!(ca.user_agent.as_deref(), Some("CustomAgent/1.0"));
        assert!(ca.featured);

        let foo = &channels[1];
        assert_eq!(foo.country.as_deref(), Some("US"));
        assert_eq!(foo.resolution.as_deref(), Some("HD"));
        assert!(!foo.featured);
    }

    #[test]
    fn ids_are_stable_and_unique() {
        let a = parse_m3u(SAMPLE);
        let b = parse_m3u(SAMPLE);
        assert_eq!(a[0].id, b[0].id);
        assert_ne!(a[0].id, a[1].id);
    }

    #[test]
    fn handles_entries_without_extinf() {
        assert!(parse_m3u("https://example.com/orphan.m3u8\n").is_empty());
    }

    #[test]
    fn maps_resolution_hints() {
        assert_eq!(resolution_hint("Channel (1080p)").as_deref(), Some("FHD"));
        assert_eq!(resolution_hint("Channel 4K").as_deref(), Some("4K"));
        assert_eq!(resolution_hint("Channel (360p)").as_deref(), Some("LD"));
        assert_eq!(resolution_hint("Showcase HD").as_deref(), Some("HD"));
        // "WHDTV" must not be read as an HD badge.
        assert_eq!(resolution_hint("WHDTV Boston"), None);
        assert_eq!(resolution_hint("No hint here"), None);
    }
}