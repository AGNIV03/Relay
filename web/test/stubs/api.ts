// Stand-in for src/lib/api.ts under `node --test` (see test/register.mjs).
// Any call fails loudly so a test can't silently depend on the network.
const offline = (path: string): Promise<never> =>
  Promise.reject(new Error(`api is stubbed in unit tests (requested ${path})`));

export const api = {
  get: <T>(path: string): Promise<T> => offline(path),
  post: <T>(path: string): Promise<T> => offline(path),
};
