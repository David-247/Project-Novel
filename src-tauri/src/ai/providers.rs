//! Provider descriptors: the one place Rust knows a provider's host and how it authenticates.
//! Each row pairs with the webview adapter `src/features/ai-tutor/providers/<id>.ts` (Task 3).
//!
//! `base_url` includes the API prefix the provider's AI SDK package expects as its `baseURL` (for
//! example `/v1`). The adapters build their SDK provider with the placeholder origin
//! `https://provider.invalid`; the fetch shim strips that origin and forwards only path + query,
//! which Rust appends to `base_url`. A `None` base URL means the host is the one the user saved for
//! that connection (local servers and custom endpoints).

/// How the stored secret is attached to a request. The secret never comes from the webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    /// `Authorization: Bearer <secret>`.
    Bearer,
    /// `<name>: <secret>` (for example Anthropic's `x-api-key`).
    Header(&'static str),
    /// No credential is sent.
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderDescriptor {
    pub id: &'static str,
    pub base_url: Option<&'static str>,
    pub auth: Auth,
    /// Headers Rust always sets for this provider (after the caller's allowlisted headers).
    pub extra_headers: &'static [(&'static str, &'static str)],
    /// The provider's page for creating an API key: the only page "Get a Key" opens (`ai_open_key_page`,
    /// in the system browser, from Rust). `None` when the provider has no key.
    pub key_url: Option<&'static str>,
    /// OAuth PKCE sign-in with a loopback redirect that ends in an API key (`oauth.rs`), if offered.
    pub sign_in: Option<SignIn>,
}

/// A provider's "Sign in with ..." endpoints (PKCE, S256; the code is traded for an API key).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignIn {
    /// The new connection's name ("OpenRouter", then "OpenRouter 2", ...).
    pub name: &'static str,
    /// Where the browser goes, with `callback_url`, `code_challenge`, `code_challenge_method` and `state`.
    pub auth_url: &'static str,
    /// Where Rust POSTs `{ code, code_verifier, code_challenge_method }`; answers `{ key }`.
    pub keys_url: &'static str,
}

const fn hosted(id: &'static str, base_url: &'static str, key_url: &'static str) -> ProviderDescriptor {
    ProviderDescriptor { id, base_url: Some(base_url), auth: Auth::Bearer, extra_headers: &[], key_url: Some(key_url), sign_in: None }
}

const fn local(id: &'static str, auth: Auth) -> ProviderDescriptor {
    ProviderDescriptor { id, base_url: None, auth, extra_headers: &[], key_url: None, sign_in: None }
}

pub const PROVIDERS: &[ProviderDescriptor] = &[
    ProviderDescriptor {
        id: "anthropic",
        base_url: Some("https://api.anthropic.com/v1"),
        auth: Auth::Header("x-api-key"),
        extra_headers: &[("anthropic-version", "2023-06-01")],
        key_url: Some("https://console.anthropic.com/settings/keys"),
        sign_in: None,
    },
    hosted("openai", "https://api.openai.com/v1", "https://platform.openai.com/api-keys"),
    hosted("xai", "https://api.x.ai/v1", "https://console.x.ai"),
    hosted("deepseek", "https://api.deepseek.com/v1", "https://platform.deepseek.com/api_keys"),
    // GLM (Zhipu AI, BigModel open platform), OpenAI-compatible.
    hosted("zhipu", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/usercenter/apikeys"),
    // Qwen (Alibaba Model Studio, international endpoint), OpenAI-compatible mode.
    hosted("qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://modelstudio.console.alibabacloud.com/"),
    // Sign in with OpenRouter: https://openrouter.ai/docs/guides/overview/auth/oauth (read 2026-11-19).
    ProviderDescriptor {
        id: "openrouter",
        base_url: Some("https://openrouter.ai/api/v1"),
        auth: Auth::Bearer,
        extra_headers: &[],
        key_url: Some("https://openrouter.ai/keys"),
        sign_in: Some(SignIn {
            name: "OpenRouter",
            auth_url: "https://openrouter.ai/auth", keys_url: "https://openrouter.ai/api/v1/auth/keys",
        }),
    },
    local("ollama", Auth::None),
    local("lmstudio", Auth::None),
    // A user-entered OpenAI-compatible endpoint; the key is optional (sent only when one is stored).
    local("custom", Auth::Bearer),
    // Sign in with ChatGPT (Task 12, research first): provisional host, fixed by that task. No key page.
    ProviderDescriptor {
        id: "chatgpt",
        base_url: Some("https://chatgpt.com/backend-api/codex"),
        auth: Auth::Bearer,
        extra_headers: &[],
        key_url: None,
        sign_in: None,
    },
];

/// The descriptor for a provider id, or `None` for an unknown id.
pub fn descriptor(id: &str) -> Option<&'static ProviderDescriptor> {
    PROVIDERS.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_is_listed_once() {
        let ids: Vec<_> = PROVIDERS.iter().map(|p| p.id).collect();
        let want = [
            "anthropic", "openai", "xai", "deepseek", "zhipu", "qwen", "openrouter", "ollama", "lmstudio", "custom",
            "chatgpt",
        ];
        assert_eq!(ids, want);
    }

    #[test]
    fn hosted_providers_use_https_and_local_ones_use_the_saved_url() {
        for p in PROVIDERS {
            match p.id {
                "ollama" | "lmstudio" | "custom" => assert!(p.base_url.is_none(), "{}", p.id),
                _ => assert!(p.base_url.unwrap().starts_with("https://"), "{}", p.id),
            }
        }
    }

    #[test]
    fn key_pages_are_https_and_only_for_providers_with_a_key() {
        for p in PROVIDERS {
            match p.id {
                "ollama" | "lmstudio" | "custom" | "chatgpt" => assert!(p.key_url.is_none(), "{}", p.id),
                _ => assert!(p.key_url.unwrap().starts_with("https://"), "{}", p.id),
            }
        }
    }

    #[test]
    fn only_openrouter_offers_a_sign_in_and_it_is_https() {
        for p in PROVIDERS {
            assert_eq!(p.sign_in.is_some(), p.id == "openrouter", "{}", p.id);
        }
        let s = descriptor("openrouter").unwrap().sign_in.unwrap();
        assert!(s.auth_url.starts_with("https://openrouter.ai/") && s.keys_url.starts_with("https://openrouter.ai/"));
    }

    #[test]
    fn anthropic_sends_its_key_and_version_headers() {
        let a = descriptor("anthropic").unwrap();
        assert_eq!(a.auth, Auth::Header("x-api-key"));
        assert_eq!(a.extra_headers, &[("anthropic-version", "2023-06-01")]);
        assert!(descriptor("nope").is_none());
    }
}
