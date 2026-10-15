import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { TaskbarAlignment, WindowMode } from './model';

export type WindowCommand =
  | { name: 'set_pinned'; args: { pinned: boolean } }
  | { name: 'set_click_through'; args: { enabled: boolean } }
  | { name: 'set_window_mode'; args: { mode: WindowMode } }
  | { name: 'set_taskbar_alignment'; args: { alignment: TaskbarAlignment } }
  | { name: 'set_taskbar_position'; args: { position: number } }
  | { name: 'set_taskbar_content_count'; args: { count: number } }
  | { name: 'begin_taskbar_drag' | 'update_taskbar_drag' | 'end_taskbar_drag' }
  | { name: 'hide_window' }
  | { name: 'start_dragging' }
  | { name: 'resize_window'; args: { preset: 'compact' | 'wide' | 'tall' } };
export interface Platform {
  readonly review: boolean;
  subscribe(listener: (state: unknown) => void): Promise<() => void>;
  getState(): Promise<unknown>;
  command(command: WindowCommand): Promise<unknown>;
}

/** This is the entire native surface: no filesystem, HTTP, shell, or arbitrary command bridge. */
export function nativePlatform(): Platform {
  const requireNative = () => { if (!isTauri()) throw new Error('Open Pi companion from its desktop tray. Browser preview has no live connection.'); };
  return {
    review: false,
    async subscribe(listener) {
      requireNative();
      return listen<unknown>('companion-state', event => listener(event.payload));
    },
    async getState() { requireNative(); return invoke<unknown>('get_state'); },
    async command(command) {
      requireNative();
      switch (command.name) {
        case 'set_pinned': return invoke('set_pinned', { pinned: command.args.pinned });
        case 'set_click_through': return invoke('set_click_through', { enabled: command.args.enabled });
        case 'set_window_mode': return invoke('set_window_mode', { mode: command.args.mode });
        case 'set_taskbar_alignment':
          if (!['left', 'center', 'right'].includes(command.args.alignment)) throw new Error('Invalid taskbar alignment');
          return invoke('set_taskbar_alignment', { alignment: command.args.alignment });
        case 'set_taskbar_position':
          if (!Number.isFinite(command.args.position) || command.args.position < 0 || command.args.position > 1) throw new Error('Invalid taskbar position');
          return invoke('set_taskbar_position', { position: command.args.position });
        case 'set_taskbar_content_count':
          if (!Number.isInteger(command.args.count) || command.args.count < 0 || command.args.count > 64) throw new Error('Invalid taskbar content count');
          return invoke('set_taskbar_content_count', { count: command.args.count });
        case 'begin_taskbar_drag': return invoke('begin_taskbar_drag');
        case 'update_taskbar_drag': return invoke('update_taskbar_drag');
        case 'end_taskbar_drag': return invoke('end_taskbar_drag');
        case 'hide_window': return invoke('hide_window');
        case 'start_dragging': return invoke('start_dragging');
        case 'resize_window': return invoke('resize_window', { preset: command.args.preset });
      }
    },
  };
}
