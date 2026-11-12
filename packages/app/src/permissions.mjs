// What each kind of window may ask Chromium for. The whole list; anything not named here is refused, and a page that
// is not one of these windows gets nothing.
export const WINDOW_PERMISSIONS = Object.freeze({
  // The device window copies text (the app console, addresses).
  device: Object.freeze(["clipboard-sanitized-write"]),
  // The bar's local web copies text as well (addresses, an access token of the emulated bar).
  "local-web": Object.freeze(["clipboard-sanitized-write"]),
  // The shell's own message page.
  message: Object.freeze([]),
});

export function permissionAllowed(kind, permission) {
  return Object.hasOwn(WINDOW_PERMISSIONS, kind) && WINDOW_PERMISSIONS[kind].includes(permission);
}
