//! Pure floating-strip policy: physical monitor rectangles, logical strip size.
//! No Explorer embedding, display mutation, native handles, or observer access.
use crate::{fit_window, Rect, WindowMode};

use serde::{Deserialize, Serialize};

/// Fixed logical dimensions shared with the frontend; no bottom or side gutter.
pub const TASKBAR_HEIGHT: f64 = 104.0;
pub const MAX_CONTENT_COUNT: u16 = 64;
const CONTROLS_WIDTH: f64 = 88.0;
const WORKSPACE_PADDING: f64 = 12.0;
const TILE_WIDTH: f64 = 112.0;
const TILE_GAP: f64 = 8.0;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Alignment {
    Left,
    #[default]
    Center,
    Right,
    Free,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Placement {
    pub alignment: Alignment,
    /// Fraction of available horizontal travel, independent of monitor DPI/size.
    pub position: f64,
}
impl Default for Placement {
    fn default() -> Self {
        Self {
            alignment: Alignment::Center,
            position: 0.5,
        }
    }
}
impl Placement {
    pub fn aligned(alignment: Alignment) -> Option<Self> {
        let position = match alignment {
            Alignment::Left => 0.0,
            Alignment::Center => 0.5,
            Alignment::Right => 1.0,
            Alignment::Free => return None,
        };
        Some(Self {
            alignment,
            position,
        })
    }
    pub fn free(position: f64) -> Option<Self> {
        (position.is_finite() && (0.0..=1.0).contains(&position)).then_some(Self {
            alignment: Alignment::Free,
            position,
        })
    }
    pub fn validate(self) -> bool {
        if self.alignment == Alignment::Free {
            Self::free(self.position).is_some()
        } else {
            Self::aligned(self.alignment) == Some(self)
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub enum PlacementRequest {
    Align(Alignment),
    Position(f64),
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlacementPlan {
    pub placement: Placement,
    pub apply_geometry: bool,
}
/// Alignment controls are also present in Office. They change only the stored
/// strip preference there, leaving Office geometry and its restore snapshot alone.
pub fn plan_placement(mode: WindowMode, request: PlacementRequest) -> Option<PlacementPlan> {
    let placement = match request {
        PlacementRequest::Align(alignment) => Placement::aligned(alignment)?,
        PlacementRequest::Position(position) if mode == WindowMode::Taskbar => {
            Placement::free(position)?
        }
        PlacementRequest::Position(_) => return None,
    };
    Some(PlacementPlan {
        placement,
        apply_geometry: mode == WindowMode::Taskbar,
    })
}
fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}
pub fn strip_rect(work: Rect, scale: f64, count: u16, placement: Placement) -> Rect {
    let work = fit_window(work, work);
    let scale = valid_scale(scale);
    let slots = f64::from(count.clamp(1, MAX_CONTENT_COUNT));
    let width =
        ((CONTROLS_WIDTH + WORKSPACE_PADDING + TILE_WIDTH * slots + TILE_GAP * (slots - 1.0))
            * scale)
            .round()
            .clamp(1.0, work.width);
    let height = (TASKBAR_HEIGHT * scale).round().clamp(1.0, work.height);
    let position = if placement.validate() {
        placement.position
    } else {
        0.5
    };
    fit_window(
        Rect {
            x: work.x + ((work.width - width) * position).round(),
            y: work.y + work.height - height,
            width,
            height,
        },
        work,
    )
}

/// A drag samples absolute native physical cursor positions; no JS deltas or
/// accumulated window offsets. Retaining a logical grab offset handles DPI changes.
#[derive(Clone, Copy, Debug)]
pub struct HorizontalDrag {
    grab_offset: f64,
}
impl HorizontalDrag {
    pub fn begin(cursor_x: f64, rect: Rect, scale: f64) -> Option<Self> {
        if !cursor_x.is_finite() || !rect.x.is_finite() {
            return None;
        }
        let grab_offset = (cursor_x - rect.x) / valid_scale(scale);
        grab_offset.is_finite().then_some(Self { grab_offset })
    }
    pub fn placement(self, cursor_x: f64, work: Rect, scale: f64, count: u16) -> Option<Placement> {
        if !cursor_x.is_finite() {
            return None;
        }
        let rect = strip_rect(work, scale, count, Placement::default());
        let travel = (work.width - rect.width).max(0.0);
        let position = if travel > 0.0 {
            ((cursor_x - self.grab_offset * valid_scale(scale) - work.x) / travel).clamp(0.0, 1.0)
        } else {
            0.5
        };
        Placement::free(position)
    }
}

/// Preserve a preferred monitor through unplug/reconnect; an absent name falls
/// back to the current monitor (or primary) without overwriting that preference.
pub fn preferred_monitor_index(
    preferred: Option<&str>,
    names: &[Option<&str>],
    fallback: usize,
) -> Option<usize> {
    preferred
        .and_then(|name| names.iter().position(|candidate| *candidate == Some(name)))
        .or_else(|| (!names.is_empty()).then_some(fallback.min(names.len().saturating_sub(1))))
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
            let rect = strip_rect(WORK, scale, 3, Placement::default());
            assert_eq!(rect.height, TASKBAR_HEIGHT * scale);
            assert_eq!(rect.width, 452.0 * scale);
            assert!((rect.x + rect.width / 2.0 - WORK.x - WORK.width / 2.0).abs() <= 0.5);
            assert_eq!(rect.y + rect.height, WORK.y + WORK.height);
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
                let rect = strip_rect(work, scale, 3, Placement::default());
                assert!(rect.width >= 1.0 && rect.height >= 1.0);
                assert!(rect.x >= work.x && rect.x + rect.width <= work.x + width);
                assert!(rect.y >= work.y && rect.y + rect.height <= work.y + height);
            }
        }
    }
    #[test]
    fn work_area_and_dpi_changes_recompute_not_accumulate() {
        let a = strip_rect(WORK, 1.0, 3, Placement::default());
        let shorter = Rect {
            height: 1000.0,
            ..WORK
        };
        assert_eq!(
            strip_rect(shorter, 1.0, 3, Placement::default()).y,
            a.y - 40.0
        );
        assert_eq!(strip_rect(WORK, 1.0, 3, Placement::default()), a);
        assert_eq!(strip_rect(WORK, 2.0, 3, Placement::default()).height, 208.0);
    }
    #[test]
    fn content_count_controls_only_bounded_width_with_no_bottom_gap() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for count in [0, 1, 2, 3, 6, 64, u16::MAX] {
                let slots = f64::from(count.clamp(1, MAX_CONTENT_COUNT));
                let expected = ((100.0 + 112.0 * slots + 8.0 * (slots - 1.0)) * scale)
                    .round()
                    .min(WORK.width);
                for alignment in [Alignment::Left, Alignment::Center, Alignment::Right] {
                    let placement = Placement::aligned(alignment).unwrap();
                    let rect = strip_rect(WORK, scale, count, placement);
                    assert_eq!(rect.width, expected);
                    assert_eq!(rect.y + rect.height, WORK.y + WORK.height);
                    assert_eq!(
                        rect.x,
                        WORK.x + ((WORK.width - expected) * placement.position).round()
                    );
                }
            }
        }
        assert_eq!(strip_rect(WORK, 1.0, 0, Placement::default()).width, 212.0);
        assert_eq!(
            strip_rect(WORK, 1.0, 64, Placement::default()).width,
            WORK.width
        );
    }
    #[test]
    fn free_placement_survives_resize_dpi_and_reconnect_without_accumulation() {
        let placement = Placement::free(0.27).unwrap();
        let original = strip_rect(WORK, 1.25, 2, placement);
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for width in [1.0, 100.0, 800.0, 3840.0] {
                let work = Rect { width, ..WORK };
                let rect = strip_rect(work, scale, 2, placement);
                assert!(rect.x >= work.x && rect.x + rect.width <= work.x + width);
                assert_eq!(rect.y + rect.height, work.y + work.height);
            }
        }
        assert_eq!(strip_rect(WORK, 1.25, 2, placement), original);
    }
    #[test]
    fn horizontal_drag_samples_absolute_cursor_and_clamps_edges() {
        let initial = strip_rect(WORK, 1.25, 2, Placement::default());
        let cursor = initial.x + 30.0;
        let drag = HorizontalDrag::begin(cursor, initial, 1.25).unwrap();
        let at_start = drag.placement(cursor, WORK, 1.25, 2).unwrap();
        let original = strip_rect(WORK, 1.25, 2, at_start);
        assert_eq!(original, initial);
        let moved = drag.placement(cursor + 150.0, WORK, 1.25, 2).unwrap();
        assert_eq!(strip_rect(WORK, 1.25, 2, moved).x, initial.x + 150.0);
        for _ in 0..100 {
            assert_eq!(
                drag.placement(cursor + 150.0, WORK, 1.25, 2).unwrap(),
                moved
            );
        }
        assert_eq!(
            drag.placement(-10000.0, WORK, 1.25, 2).unwrap().position,
            0.0
        );
        assert_eq!(
            drag.placement(10000.0, WORK, 1.25, 2).unwrap().position,
            1.0
        );
        assert_eq!(
            drag.placement(cursor, WORK, 1.25, 64).unwrap().position,
            0.5
        );
        assert!(drag.placement(f64::NAN, WORK, 1.25, 2).is_none());
        assert!(HorizontalDrag::begin(f64::INFINITY, initial, 1.0).is_none());
        assert_eq!(strip_rect(WORK, 1.25, 2, moved).y, initial.y);
    }
    #[test]
    fn monitor_fallback_preserves_preference_until_reconnect_and_office_move() {
        let saved = Some("second");
        let both = [Some("first"), Some("second")];
        assert_eq!(preferred_monitor_index(saved, &both, 0), Some(1));
        assert_eq!(preferred_monitor_index(saved, &[Some("first")], 0), Some(0));
        assert_eq!(preferred_monitor_index(saved, &[], 0), None);
        assert_eq!(preferred_monitor_index(saved, &both, 0), Some(1));
        // A later Office -> strip entry intentionally omits the saved preference.
        assert_eq!(preferred_monitor_index(None, &both, 0), Some(0));
        assert_eq!(preferred_monitor_index(None, &both, 1), Some(1));
        assert_eq!(
            preferred_monitor_index(Some("removed"), &both, usize::MAX),
            Some(1)
        );
    }
    #[test]
    fn invalid_placement_cannot_escape_work_area_or_enter_persistence() {
        assert!(Placement::aligned(Alignment::Free).is_none());
        for position in [-1.0, 1.01, f64::NAN, f64::INFINITY] {
            assert!(Placement::free(position).is_none());
            let invalid = Placement {
                alignment: Alignment::Free,
                position,
            };
            assert_eq!(
                strip_rect(WORK, 1.0, 1, invalid),
                strip_rect(WORK, 1.0, 1, Placement::default())
            );
        }
        assert!(!Placement {
            alignment: Alignment::Left,
            position: 0.5
        }
        .validate());
    }
    #[test]
    fn autohide_animation_retains_flush_baseline_for_every_alignment() {
        let monitor = Rect {
            x: -1920.0,
            y: -100.0,
            width: 1920.0,
            height: 1080.0,
        };
        for visible in [0.0, 2.0, 12.0, 48.0] {
            let bar = Rect {
                y: monitor.y + monitor.height - visible,
                height: 48.0,
                ..monitor
            };
            let work = reserve_autohide_bar(monitor, monitor, bar, Edge::Bottom);
            for placement in [
                Placement::default(),
                Placement::aligned(Alignment::Right).unwrap(),
                Placement::free(0.27).unwrap(),
            ] {
                let rect = strip_rect(work, 1.5, 3, placement);
                assert_eq!(rect.y + rect.height, monitor.y + monitor.height - visible);
            }
        }
    }
    #[test]
    fn office_alignment_updates_preference_without_native_geometry_or_free_drag() {
        for alignment in [Alignment::Left, Alignment::Center, Alignment::Right] {
            let plan =
                plan_placement(WindowMode::Office, PlacementRequest::Align(alignment)).unwrap();
            assert!(!plan.apply_geometry);
            assert_eq!(plan.placement, Placement::aligned(alignment).unwrap());
            let strip =
                plan_placement(WindowMode::Taskbar, PlacementRequest::Align(alignment)).unwrap();
            assert!(strip.apply_geometry);
            assert_eq!(strip.placement, plan.placement);
        }
        assert!(plan_placement(WindowMode::Office, PlacementRequest::Position(0.3)).is_none());
        assert!(
            plan_placement(WindowMode::Office, PlacementRequest::Align(Alignment::Free)).is_none()
        );
        assert!(
            plan_placement(WindowMode::Taskbar, PlacementRequest::Position(f64::NAN)).is_none()
        );
        assert!(
            plan_placement(WindowMode::Taskbar, PlacementRequest::Position(0.3))
                .unwrap()
                .apply_geometry
        );
    }
    #[test]
    fn placement_commands_are_declared_in_both_native_build_and_permissions() {
        let build = include_str!("../../../src-tauri/build.rs");
        let permission = include_str!("../../../src-tauri/permissions/companion.toml");
        let main = include_str!("../../../src-tauri/src/main.rs");
        for command in [
            "set_taskbar_alignment",
            "set_taskbar_position",
            "set_taskbar_content_count",
            "begin_taskbar_drag",
            "update_taskbar_drag",
            "end_taskbar_drag",
        ] {
            assert!(build.contains(&format!("\"{command}\"")));
            assert!(permission.contains(&format!("\"{command}\"")));
            assert!(main.contains(&format!("async fn {command}(")));
        }
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
    #[test]
    fn office_restore_selects_its_rectangle_monitor_not_strip_preference() {
        // The view still reports Taskbar during Office restoration. The native
        // restore boundary must explicitly ignore the strip's saved monitor.
        let source = include_str!("../../../src-tauri/src/main.rs");
        let restore = source
            .split("fn apply_office_snapshot(")
            .nth(1)
            .unwrap()
            .split("fn change_mode(")
            .next()
            .unwrap();
        assert!(restore.contains("match display_layout_for(window, None)"));
        assert!(!restore.contains("match display_layout(window)"));
    }
    #[test]
    fn native_physical_rect_moves_before_remeasuring_and_resizing() {
        let source = include_str!("../../../src-tauri/src/main.rs");
        let apply = source
            .split("fn apply_rect(")
            .nth(1)
            .unwrap()
            .split("fn set_minimum(")
            .next()
            .unwrap();
        let moving = apply.find(".set_position(").unwrap();
        let remeasure = apply
            .find("let after_move = current_rect(window)?")
            .unwrap();
        let resizing = apply.find(".set_size(").unwrap();
        let final_origin = apply
            .find("let after_size = current_rect(window)?")
            .unwrap();
        assert!(moving < remeasure && remeasure < resizing && resizing < final_origin);
        assert!(apply[final_origin..].contains(".set_position("));
    }
}
