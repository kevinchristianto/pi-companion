//! Pure floating-strip policy: physical monitor rectangles, logical strip size.
//! No Explorer embedding, display mutation, native handles, or observer access.
use crate::{fit_window, Rect, WindowMode};

/// Kept in sync with the frontend's strip viewport height: 64px art and a
/// persistent bottom status in place of the visible name, with bounded padding.
pub const TASKBAR_HEIGHT: f64 = 104.0;
pub const TASKBAR_MARGIN: f64 = 12.0;

pub fn strip_rect(work: Rect, scale: f64) -> Rect {
    let work = fit_window(work, work);
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let side = (TASKBAR_MARGIN * scale)
        .round()
        .min((work.width - 1.0) / 2.0);
    let bottom = (TASKBAR_MARGIN * scale)
        .round()
        .min((work.height - 1.0) / 2.0);
    let width = (work.width - side * 2.0).max(1.0);
    let height = (TASKBAR_HEIGHT * scale)
        .round()
        .clamp(1.0, work.height - bottom);
    fit_window(
        Rect {
            x: work.x + (work.width - width) / 2.0,
            y: work.y + work.height - bottom - height,
            width,
            height,
        },
        work,
    )
}

/// An ordinary maximized window covers only the work area and is not fullscreen.
/// Native code filters hidden/minimized/cloaked/shell/own-process windows first.
pub fn covers_monitor(window: Rect, monitor: Rect) -> bool {
    [window, monitor].iter().all(|r| {
        [r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
            && r.width > 0.0
            && r.height > 0.0
    }) && window.x <= monitor.x + 2.0
        && window.y <= monitor.y + 2.0
        && window.x + window.width >= monitor.x + monitor.width - 2.0
        && window.y + window.height >= monitor.y + monitor.height - 2.0
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Left,
    Top,
    Right,
    Bottom,
}

/// Reserve only the visible intersection of an auto-hide bar with this monitor.
/// This follows an expanding/retracting bar without retaining its hidden size.
pub fn reserve_autohide_bar(work: Rect, monitor: Rect, bar: Rect, edge: Edge) -> Rect {
    let left = bar.x.max(monitor.x);
    let top = bar.y.max(monitor.y);
    let right = (bar.x + bar.width).min(monitor.x + monitor.width);
    let bottom = (bar.y + bar.height).min(monitor.y + monitor.height);
    if left >= right || top >= bottom {
        return work;
    }
    let mut result = work;
    match edge {
        Edge::Left if left <= monitor.x + 2.0 => {
            result.x = work.x.max(right);
            result.width = work.x + work.width - result.x;
        }
        Edge::Top if top <= monitor.y + 2.0 => {
            result.y = work.y.max(bottom);
            result.height = work.y + work.height - result.y;
        }
        Edge::Right if right >= monitor.x + monitor.width - 2.0 => {
            result.width = work.width.min(left - work.x);
        }
        Edge::Bottom if bottom >= monitor.y + monitor.height - 2.0 => {
            result.height = work.height.min(top - work.y);
        }
        _ => {}
    }
    fit_window(result, work)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OfficeSnapshot {
    pub rect: Rect,
    pub pinned: bool,
    pub resizable: bool,
    pub minimum: Option<(u32, u32)>,
    pub skip_taskbar: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Visibility {
    pub user_hidden: bool,
    pub fullscreen_hidden: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VisibilityAction {
    None,
    Hide,
    ShowWithoutFocus,
}

impl Visibility {
    /// Unknown is a failed/transient native read, never evidence to show a
    /// fullscreen-hidden window or to hide a currently visible window.
    pub fn observed(self, mode: WindowMode, fullscreen: Option<bool>) -> (Self, VisibilityAction) {
        self.plan(mode, fullscreen.unwrap_or(self.fullscreen_hidden))
    }
    /// An explicit tray show request is distinct from automatic restoration.
    /// The caller must obtain a valid display probe before planning this action.
    pub fn requested_show(mode: WindowMode, fullscreen: bool) -> (Self, VisibilityAction) {
        let fullscreen_hidden = mode == WindowMode::Taskbar && fullscreen;
        (
            Self {
                user_hidden: false,
                fullscreen_hidden,
            },
            if fullscreen_hidden {
                VisibilityAction::Hide
            } else {
                VisibilityAction::ShowWithoutFocus
            },
        )
    }
    /// Callers commit the returned state only after its native action succeeds.
    pub fn plan(self, mode: WindowMode, fullscreen: bool) -> (Self, VisibilityAction) {
        let fullscreen_hidden = !self.user_hidden && mode == WindowMode::Taskbar && fullscreen;
        let action = if self.user_hidden {
            VisibilityAction::None
        } else if fullscreen_hidden && !self.fullscreen_hidden {
            VisibilityAction::Hide
        } else if !fullscreen_hidden && self.fullscreen_hidden {
            VisibilityAction::ShowWithoutFocus
        } else {
            VisibilityAction::None
        };
        (
            Self {
                user_hidden: self.user_hidden,
                fullscreen_hidden,
            },
            action,
        )
    }

    pub fn hide_by_user(&mut self) {
        self.user_hidden = true;
        self.fullscreen_hidden = false;
    }
    pub fn restore_by_user(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const WORK: Rect = Rect {
        x: -1920.0,
        y: -100.0,
        width: 1920.0,
        height: 1040.0,
    };
    #[test]
    fn strip_is_centered_above_work_area_bottom_at_each_dpi() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let rect = strip_rect(WORK, scale);
            assert_eq!(rect.height, TASKBAR_HEIGHT * scale);
            assert_eq!(rect.width, WORK.width - TASKBAR_MARGIN * scale * 2.0);
            assert_eq!(rect.x + rect.width / 2.0, WORK.x + WORK.width / 2.0);
            assert_eq!(
                rect.y + rect.height,
                WORK.y + WORK.height - TASKBAR_MARGIN * scale
            );
        }
    }
    #[test]
    fn tiny_or_invalid_geometry_never_escapes_work_area() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY, 2.0] {
            for (width, height) in [(1.0, 1.0), (50.0, 30.0), (300.0, 200.0)] {
                let work = Rect {
                    width,
                    height,
                    ..WORK
                };
                let rect = strip_rect(work, scale);
                assert!(rect.width >= 1.0 && rect.height >= 1.0);
                assert!(rect.x >= work.x && rect.x + rect.width <= work.x + width);
                assert!(rect.y >= work.y && rect.y + rect.height <= work.y + height);
            }
        }
    }
    #[test]
    fn work_area_and_dpi_changes_recompute_not_accumulate() {
        let a = strip_rect(WORK, 1.0);
        let shorter = Rect {
            height: 1000.0,
            ..WORK
        };
        assert_eq!(strip_rect(shorter, 1.0).y, a.y - 40.0);
        assert_eq!(strip_rect(WORK, 1.0), a);
        assert_eq!(strip_rect(WORK, 2.0).height, 208.0);
    }
    #[test]
    fn saved_office_rect_is_fitted_after_monitor_removal() {
        let saved = Rect {
            x: 2500.0,
            y: 1200.0,
            width: 720.0,
            height: 420.0,
        };
        let restored = fit_window(saved, WORK);
        assert_eq!((restored.width, restored.height), (720.0, 420.0));
        assert_eq!((restored.x, restored.y), (-720.0, 520.0));
    }
    #[test]
    fn only_full_monitor_coverage_counts() {
        let monitor = Rect {
            height: 1080.0,
            ..WORK
        };
        assert!(covers_monitor(monitor, monitor));
        assert!(!covers_monitor(WORK, monitor));
        assert!(!covers_monitor(Rect { x: 0.0, ..monitor }, monitor));
        assert!(!covers_monitor(
            Rect {
                width: f64::NAN,
                ..monitor
            },
            monitor
        ));
    }
    #[test]
    fn expanding_autohide_bar_reduces_work_area_only_while_visible() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        let hidden = Rect {
            y: 1078.0,
            height: 48.0,
            ..monitor
        };
        let shown = Rect {
            y: 1032.0,
            height: 48.0,
            ..monitor
        };
        assert_eq!(
            reserve_autohide_bar(monitor, monitor, hidden, Edge::Bottom).height,
            1078.0
        );
        assert_eq!(
            reserve_autohide_bar(monitor, monitor, shown, Edge::Bottom).height,
            1032.0
        );
        let outside = Rect {
            y: 1080.0,
            ..hidden
        };
        assert_eq!(
            reserve_autohide_bar(monitor, monitor, outside, Edge::Bottom),
            monitor
        );
    }
    #[test]
    fn fullscreen_exit_restores_only_automatically_hidden_strip() {
        let state = Visibility::default();
        let (hidden, action) = state.plan(WindowMode::Taskbar, true);
        assert_eq!(action, VisibilityAction::Hide);
        assert_eq!(
            hidden.plan(WindowMode::Taskbar, true).1,
            VisibilityAction::None
        );
        assert_eq!(
            hidden.plan(WindowMode::Taskbar, false),
            (state, VisibilityAction::ShowWithoutFocus)
        );
        assert_eq!(
            hidden.plan(WindowMode::Office, true),
            (state, VisibilityAction::ShowWithoutFocus)
        );
    }
    #[test]
    fn explicit_hide_survives_every_poll_and_mode_change() {
        let mut state = Visibility {
            fullscreen_hidden: true,
            ..Visibility::default()
        };
        state.hide_by_user();
        for mode in [WindowMode::Taskbar, WindowMode::Office] {
            for fullscreen in [true, false, true, false] {
                let (next, action) = state.plan(mode, fullscreen);
                assert!(next.user_hidden);
                assert!(!next.fullscreen_hidden);
                assert_eq!(action, VisibilityAction::None);
                state = next;
            }
        }
        state.restore_by_user();
        assert_eq!(state, Visibility::default());
    }
    #[test]
    fn failed_native_action_can_leave_policy_uncommitted_for_retry() {
        let state = Visibility::default();
        let planned = state.plan(WindowMode::Taskbar, true);
        // Native failure: don't commit planned. The next poll retries the hide.
        assert_eq!(state.plan(WindowMode::Taskbar, true), planned);
        assert!(!state.fullscreen_hidden);
    }
    #[test]
    fn tray_show_during_fullscreen_commits_matching_public_visibility() {
        let mut hidden = Visibility::default();
        hidden.hide_by_user();
        // A failed probe leaves hidden untouched. A valid probe can now plan.
        assert!(hidden.user_hidden && !hidden.fullscreen_hidden);
        let (next, action) = Visibility::requested_show(WindowMode::Taskbar, true);
        assert!(!next.user_hidden && next.fullscreen_hidden);
        assert_eq!(action, VisibilityAction::Hide);
        assert_eq!(
            next.plan(WindowMode::Taskbar, false).1,
            VisibilityAction::ShowWithoutFocus
        );
        let (next, action) = Visibility::requested_show(WindowMode::Taskbar, false);
        assert_eq!(next, Visibility::default());
        assert_eq!(action, VisibilityAction::ShowWithoutFocus);
    }
    #[test]
    fn failed_fullscreen_probe_preserves_both_visible_and_suspended_states() {
        for fullscreen_hidden in [true, false] {
            let state = Visibility {
                fullscreen_hidden,
                user_hidden: false,
            };
            assert_eq!(
                state.observed(WindowMode::Taskbar, None),
                (state, VisibilityAction::None)
            );
        }
        let state = Visibility {
            fullscreen_hidden: true,
            user_hidden: false,
        };
        assert_eq!(
            state.observed(WindowMode::Office, None),
            (Visibility::default(), VisibilityAction::ShowWithoutFocus)
        );
    }
    #[test]
    fn mode_state_defaults_and_recovery_contract_are_serialized() {
        let mut state = crate::WindowState::default();
        assert_eq!(serde_json::to_value(&state).unwrap()["mode"], "office");
        assert_eq!(
            serde_json::to_value(&state).unwrap()["fullscreenHidden"],
            false
        );
        assert!(!state.can_enter_mode(WindowMode::Taskbar));
        assert!(state.can_enter_mode(WindowMode::Office));
        state.recovery_available = true;
        assert!(state.can_enter_mode(WindowMode::Taskbar));
        state.mode = WindowMode::Taskbar;
        state.fullscreen_hidden = true;
        state.click_through = true;
        state.pinned = true;
        state.restored();
        assert_eq!(state.mode, WindowMode::Office);
        assert!(!state.click_through && !state.fullscreen_hidden);
        assert!(state.pinned);
        assert!(serde_json::from_str::<WindowMode>("\"other\"").is_err());
    }
}
