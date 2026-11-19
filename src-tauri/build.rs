fn main() {
    // The target triple, for the tests that run the fetched sidecar (binaries/typst-<triple>).
    println!(
        "cargo:rustc-env=NOVEL_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("cargo sets TARGET for build scripts")
    );
    tauri_build::build()
}
