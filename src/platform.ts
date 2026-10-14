import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type WindowCommand =
  | { name: 'set_pinned'; args: { pinned: boolean } }
  | { name: 'set_click_through'; args: { enabled: boolean } }
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
        case 'hide_window': return invoke('hide_window');
        case 'start_dragging': return invoke('start_dragging');
        case 'resize_window': return invoke('resize_window', { preset: command.args.preset });
      }
    },
  };
}
