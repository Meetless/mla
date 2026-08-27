// `mla login` browser-login transport: the CLI's binding of `@meetless/native-auth`.
//
// EXTRACTED 2026-08-20 (B4, proposal §4.2.3). The whole loopback-PKCE dance moved
// to `@meetless/native-auth` so a desktop app or an editor plugin can sign a human
// in without depending on `packages/cli`. The flow was already RFC 8252's
// recommended native-app flow; the earlier premise that a non-CLI client "has no
// loopback listener it should be binding" was retracted on 2026-08-19, so the work
// was extraction rather than a second protocol.
//
// THIS FILE IS THE BINDING, NOT A COPY. Two things were hard-coded in the module
// because there was only ever one client, and both are supplied here:
//
//   clientId   "mla". A second client is a different string, not a fork.
//   fetchImpl  the CLI's egress wrapper, which enforces the host allowlist and
//              body redaction. The package takes it as a PORT precisely so that
//              enforcement stays owned by the CLI (`egress-ownership.spec.ts`
//              asserts no outbound call bypasses it) rather than being
//              re-implemented inside a shared package where the CLI's rules do not
//              apply.
//
// LOADED FROM THE BUNDLE, LIKE trace-core. `@meetless/native-auth` is private and
// not on the npm registry, so a real `workspace:*` RUNTIME dependency would make
// `npm i -g @meetless/mla` fail to resolve it, and the pkg snapshot has no ESM
// dynamic-import callback either. scripts/bundle-esm.js compiles it to
// dist/bundles/native-auth.js and the package keeps it as a build-only
// devDependency. This was a live break introduced and caught during the
// extraction: the first version added it to `dependencies`, which the bundler's
// own header warns against in the same words.
//
// Every export below keeps its old name and signature, so existing call sites and
// tests are unchanged.

import * as path from "path";
import type {
  BrowserLoginOptions as NativeBrowserLoginOptions,
  BrowserOpener,
  LoginUser,
  LoginWorkspace,
  LoopbackServer,
  NativeAuthFetch,
  Pkce,
  TokenBundle,
} from "@meetless/native-auth";
import { egressFetch } from "./egress/fetch";
import { mlaUserAgent } from "./observability";

export type { BrowserOpener, LoginUser, LoginWorkspace, LoopbackServer, Pkce, TokenBundle };

interface NativeAuthModule {
  consoleUrlFromControl: (controlUrl: string) => string | null;
  exchangeGrant: (
    controlUrl: string,
    code: string,
    codeVerifier: string,
    deps: { fetchImpl: NativeAuthFetch; userAgent: string },
    timeoutMs?: number,
  ) => Promise<TokenBundle>;
  generatePkce: () => Pkce;
  generateState: () => string;
  openBrowser: (
    url: string,
    opts?: { platform?: NodeJS.Platform; run?: BrowserOpener },
  ) => Promise<number>;
  openLoopbackServer: (opts: { state: string; port?: number }) => Promise<LoopbackServer>;
  runBrowserLogin: (opts: NativeBrowserLoginOptions) => Promise<TokenBundle>;
}

// Prefer the bundle (require() works in the pkg snapshot and in an npm install);
// fall back to the workspace package for dev (ts-node, no dist/bundles). Only fall
// through on module-not-found, so a real load error in the bundle surfaces instead
// of being masked. dist/lib/login.js -> dist/bundles.
function loadNativeAuth(): NativeAuthModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.resolve(__dirname, "..", "bundles", "native-auth.js")) as NativeAuthModule;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") throw e;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@meetless/native-auth") as NativeAuthModule;
  }
}

const nativeAuth = loadNativeAuth();

export const consoleUrlFromControl = nativeAuth.consoleUrlFromControl;
export const generatePkce = nativeAuth.generatePkce;
export const generateState = nativeAuth.generateState;
export const openBrowser = nativeAuth.openBrowser;
export const openLoopbackServer = nativeAuth.openLoopbackServer;

/** The CLI's `client_id`. One string, one place. */
export const MLA_CLIENT_ID = "mla";

/**
 * The CLI's transport, bound once.
 *
 * `egressFetch` is a REGISTERED PASSTHROUGH for this endpoint: redacting a PKCE
 * verifier would fail the exchange, and that exemption is recorded against this
 * caller in `egress-caller-bodies.spec.ts`. Keeping the binding here keeps that
 * registration pointing at CLI code, which is where the allowlist lives.
 */
const cliTransport = { fetchImpl: egressFetch as NativeAuthFetch, userAgent: mlaUserAgent() };

export function exchangeGrant(
  controlUrl: string,
  code: string,
  codeVerifier: string,
  timeoutMs = 15000,
): Promise<TokenBundle> {
  return nativeAuth.exchangeGrant(controlUrl, code, codeVerifier, cliTransport, timeoutMs);
}

/** The CLI's options: the package's, minus the three the CLI always supplies. */
export type BrowserLoginOptions = Omit<
  NativeBrowserLoginOptions,
  "clientId" | "fetchImpl" | "userAgent"
>;

export function runBrowserLogin(opts: BrowserLoginOptions): Promise<TokenBundle> {
  return nativeAuth.runBrowserLogin({
    ...opts,
    clientId: MLA_CLIENT_ID,
    ...cliTransport,
    // Default the exchange to the CLI-bound one, so a caller that does not inject
    // `exchangeFn` still goes through the egress wrapper on a path the egress
    // ownership test can see.
    exchangeFn: opts.exchangeFn ?? exchangeGrant,
  });
}
