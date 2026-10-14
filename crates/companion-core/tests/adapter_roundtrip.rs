//! Development-only integration: the application has no Node sidecar. Node 24 is
//! used here solely to execute the standalone Pi extension against a real bridge.
use companion_core::{
    bridge::{self, BridgeConfig, SecretToken},
    Observer,
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
};

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
    let output = tokio::task::spawn_blocking(move || {
        Command::new("node")
            .arg(script)
            .arg(origin)
            .env_remove("PI_COMPANION_CONNECTION_FILE")
            .output()
    })
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

/// Exercise the normal extension entry, without a loader/request/heartbeat override,
/// while a real application bridge appears later and then restarts with a new token.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn normal_pi_launch_discovers_late_app_and_real_bridge_restart() {
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../observer/tests/rust-discovery-roundtrip.mjs");
        let mut child = Command::new("node")
            .arg(script)
            .env_remove("PI_COMPANION_CONNECTION_FILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Node 24 must be on PATH for adapter integration tests");
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut errors = child.stderr.take().unwrap();
        let mut phases = Vec::new();
        let mut active: Option<bridge::BridgeHandle> = None;
        let mut observer = Observer::new();
        loop {
            let mut line = String::new();
            if output.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let phase = line.trim().to_owned();
            phases.push(phase.clone());
            match phase.as_str() {
                "start" | "restart" => {
                    if let Some(previous) = active.take() {
                        runtime.block_on(previous.shutdown()).unwrap();
                    }
                    observer = Observer::new();
                    // Public, immutable test markers only; never generate real credentials.
                    let token = if phase == "start" {
                        "TEST_ONLY_NOT_A_REAL_CREDENTIAL_0123456789"
                    } else {
                        "TEST_ONLY_ROTATED_NOT_A_REAL_CREDENTIAL_9876543210"
                    };
                    let mut config = BridgeConfig::new(SecretToken::new(token.into()).unwrap());
                    config.port = 0;
                    let handle = runtime
                        .block_on(bridge::start(observer.clone(), config))
                        .unwrap();
                    writeln!(
                        input,
                        "{}",
                        serde_json::json!({"version": 1, "url": format!("http://{}", handle.local_addr()), "token": token})
                    )
                    .unwrap();
                    active = Some(handle);
                }
                "done" => break,
                _ => panic!("Unexpected discovery fixture phase"),
            }
        }
        let status = child.wait().unwrap();
        let mut stderr = String::new();
        errors.read_to_string(&mut stderr).unwrap();
        if let Some(handle) = active {
            runtime.block_on(handle.shutdown()).unwrap();
        }
        assert!(status.success(), "No-env discovery fixture failed: {stderr}");
        assert_eq!(phases, ["start", "restart", "done"]);
        assert!(observer.snapshot().agents.is_empty());
    })
    .await
    .unwrap();
}
