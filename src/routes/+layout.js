// Client-rendered SPA: no SSR, prerender the shell, hydrate on the client.
// Deep links survive a hard refresh, and the same static shell can be wrapped
// with Capacitor for native iOS/Android later.
export const prerender = true;
export const ssr = false;
export const csr = true;
