//! Development-only integration: the application has no Node sidecar. Node 24 is
//! used here solely to execute the standalone Pi extension against a real bridge.
use companion_core::{
    bridge::{self, BridgeConfig, SecretToken},
    Observer,
};
use std::{path::PathBuf, process::Command};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_pi_adapter_roundtrips_through_rust_bridge() {
    let observer = Observer::new();
    let mut config = BridgeConfig::new(
        SecretToken::new("TEST_ONLY_NOT_A_REAL_CREDENTIAL_0123456789".into()).unwrap(),
    );
    config.port = 0;
    let bridge = bridge::start(observer.clone(), config).await.unwrap();
    let origin = format!("http://{}", bridge.local_addr());
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../observer/tests/rust-roundtrip.mjs");
    let output =
        tokio::task::spawn_blocking(move || Command::new("node").arg(script).arg(origin).output())
            .await
            .unwrap()
            .expect("Node 24 must be on PATH for adapter integration tests");
    bridge.shutdown().await.unwrap();
    assert!(
        output.status.success(),
        "adapter integration failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(observer.snapshot().agents.is_empty());
}
