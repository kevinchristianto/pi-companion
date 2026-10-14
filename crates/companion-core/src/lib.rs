//! In-memory, read-only Pi observer. No commands are sent to agents and no prompts,
//! credentials, session metadata, or activity are persisted by this crate.

pub mod bridge;
mod model;
mod state;

pub use model::*;
pub use state::{Observer, StateStore};
