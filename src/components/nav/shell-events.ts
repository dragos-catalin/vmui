export const PALETTE_EVENT = "vmui:command-palette";
export const SIDEBAR_TOGGLE_EVENT = "vmui:sidebar-toggle";
export const SIDEBAR_COLLAPSED_KEY = "vmui.sidebar.collapsed";
/** Cookie mirror of the rail state ("1" = rail) so the server can render the right width on first paint. */
export const SIDEBAR_COOKIE = "vmui_sidebar";
export const RECENT_ROUTES_KEY = "vmui.recent";

export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
}

export function toggleSidebarRail() {
  window.dispatchEvent(new CustomEvent(SIDEBAR_TOGGLE_EVENT));
}

/** Motion layoutId shared by the topbar search trigger and the palette surface (open/close morph). */
export const PALETTE_LAYOUT_ID = "vatra-palette";

// Palette open state as a tiny external store: the topbar trigger hides its morph layer while open.
let paletteOpen = false;
const paletteListeners = new Set<() => void>();
export function setPaletteOpenState(v: boolean) {
  if (paletteOpen === v) return;
  paletteOpen = v;
  for (const l of paletteListeners) l();
}
export function subscribePaletteOpen(l: () => void) {
  paletteListeners.add(l);
  return () => {
    paletteListeners.delete(l);
  };
}
export function getPaletteOpen() {
  return paletteOpen;
}

/** True when focus is somewhere single-key shortcuts must not fire (text entry or a composite ARIA widget). */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.closest('[contenteditable="true"],[role="combobox"],[role="listbox"],[role="grid"],[role="textbox"],[role="slider"],[role="menu"]') !== null;
}
