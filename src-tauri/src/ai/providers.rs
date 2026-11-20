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
}

const fn hosted(id: &'static str, base_url: &'static str) -> ProviderDescriptor {
    ProviderDescriptor { id, base_url: Some(base_url), auth: Auth::Bearer, extra_headers: &[] }
}

pub const PROVIDERS: &[ProviderDescriptor] = &[
    ProviderDescriptor {
        id: "anthropic",
        base_url: Some("https://api.anthropic.com/v1"),
        auth: Auth::Header("x-api-key"),
        extra_headers: &[("anthropic-version", "2023-06-01")],
    },
    hosted("openai", "https://api.openai.com/v1"),
    hosted("xai", "https://api.x.ai/v1"),
    hosted("deepseek", "https://api.deepseek.com/v1"),
    // GLM (Zhipu AI, BigModel open platform), OpenAI-compatible.
    hosted("zhipu", "https://open.bigmodel.cn/api/paas/v4"),
    // Qwen (Alibaba Model Studio, international endpoint), OpenAI-compatible mode.
    hosted("qwen", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    hosted("openrouter", "https://openrouter.ai/api/v1"),
    ProviderDescriptor { id: "ollama", base_url: None, auth: Auth::None, extra_headers: &[] },
    ProviderDescriptor { id: "lmstudio", base_url: None, auth: Auth::None, extra_headers: &[] },
    // A user-entered OpenAI-compatible endpoint; the key is optional (sent only when one is stored).
    ProviderDescriptor { id: "custom", base_url: None, auth: Auth::Bearer, extra_headers: &[] },
    // Sign in with ChatGPT (Task 12, research first): provisional host, fixed by that task.
    hosted("chatgpt", "https://chatgpt.com/backend-api/codex"),
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
    fn anthropic_sends_its_key_and_version_headers() {
        let a = descriptor("anthropic").unwrap();
        assert_eq!(a.auth, Auth::Header("x-api-key"));
        assert_eq!(a.extra_headers, &[("anthropic-version", "2023-06-01")]);
        assert!(descriptor("nope").is_none());
    }
}
