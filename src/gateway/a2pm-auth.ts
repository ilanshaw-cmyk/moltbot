/**
 * A2PM Authentication Handler for ClawdBot
 *
 * This module enables ClawdBot to use A2PM's authentication system.
 * It checks for the a2pm_refresh cookie (shared across scribasound.com subdomains)
 * and verifies the session with A2PM's /api/auth/verify-session endpoint.
 *
 * If not authenticated, it redirects to A2PM's login page.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// A2PM API URL for session verification
const A2PM_API_URL = process.env.A2PM_API_URL || "https://a2pm.scribasound.com";
const A2PM_LOGIN_URL = `${A2PM_API_URL}/auth/signin`;

// Cookie name used by A2PM (must match server/routes/auth.js)
const A2PM_REFRESH_COOKIE_NAME = "a2pm_refresh";

export interface A2PMUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  avatarUrl?: string;
}

export interface A2PMAuthResult {
  authenticated: boolean;
  user?: A2PMUser;
  error?: string;
}

/**
 * Parse cookies from the request
 */
function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};
  const parts = cookieHeader.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }
  return cookies;
}

/**
 * Verify the session with A2PM
 */
export async function verifyA2PMSession(refreshToken: string): Promise<A2PMAuthResult> {
  try {
    const response = await fetch(`${A2PM_API_URL}/api/auth/verify-session`, {
      method: "GET",
      headers: {
        Cookie: `${A2PM_REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}`,
      },
      // Don't follow redirects - we want to handle them
      redirect: "manual",
    });

    if (response.status === 200) {
      const data = (await response.json()) as {
        success: boolean;
        authenticated: boolean;
        user?: A2PMUser;
        error?: string;
      };
      if (data.success && data.authenticated && data.user) {
        return {
          authenticated: true,
          user: data.user,
        };
      }
    }

    return {
      authenticated: false,
      error: "Session not valid",
    };
  } catch (err) {
    console.error("[A2PM Auth] Failed to verify session:", err);
    return {
      authenticated: false,
      error: "Failed to verify session with A2PM",
    };
  }
}

/**
 * Get A2PM login URL with return redirect
 */
export function getA2PMLoginUrl(returnUrl: string): string {
  const url = new URL(A2PM_LOGIN_URL);
  url.searchParams.set("returnTo", returnUrl);
  return url.toString();
}

/**
 * Build the current request URL for redirecting back after login
 */
function getRequestUrl(req: IncomingMessage): string {
  const host = req.headers.host || "clawdbot.scribasound.com";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const path = req.url || "/";
  return `${proto}://${host}${path}`;
}

/**
 * Send HTML redirect response
 */
function sendRedirect(res: ServerResponse, url: string): void {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=${url}"></head><body>Redirecting to login...</body></html>`,
  );
}

/**
 * Send JSON error response
 */
function sendJsonError(res: ServerResponse, status: number, error: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: false, error }));
}

export interface A2PMAuthOptions {
  /** Skip auth for specific paths (e.g. health checks) */
  skipPaths?: string[];
  /** Enable A2PM auth (defaults to checking CLAWDBOT_A2PM_AUTH env var) */
  enabled?: boolean;
}

const DEFAULT_SKIP_PATHS = ["/health", "/healthz", "/api/health"];

/**
 * HTTP request handler that checks A2PM authentication before serving content.
 *
 * For browser requests (Accept: text/html), redirects to A2PM login if not authenticated.
 * For API requests, returns 401 JSON response if not authenticated.
 *
 * @returns true if the request was handled (either authenticated or rejected)
 *          false if auth check is disabled or should be skipped
 */
export async function handleA2PMAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: A2PMAuthOptions,
): Promise<boolean | A2PMUser> {
  // Check if A2PM auth is enabled
  const enabled = opts?.enabled ?? process.env.CLAWDBOT_A2PM_AUTH === "true";
  if (!enabled) {
    return false;
  }

  // Skip auth for specific paths
  const url = new URL(req.url || "/", "http://localhost");
  const skipPaths = opts?.skipPaths ?? DEFAULT_SKIP_PATHS;
  if (skipPaths.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) {
    return false;
  }

  // Parse cookies and get refresh token
  const cookies = parseCookies(req);
  const refreshToken = cookies[A2PM_REFRESH_COOKIE_NAME];

  if (!refreshToken) {
    // No session cookie - check if this is a browser or API request
    const acceptHeader = req.headers.accept || "";
    const isBrowserRequest = acceptHeader.includes("text/html");

    if (isBrowserRequest) {
      // Redirect to A2PM login
      const returnUrl = getRequestUrl(req);
      const loginUrl = getA2PMLoginUrl(returnUrl);
      sendRedirect(res, loginUrl);
      return true;
    } else {
      // API request - return 401
      sendJsonError(res, 401, "Authentication required. Please sign in at A2PM.");
      return true;
    }
  }

  // Verify the session with A2PM
  const authResult = await verifyA2PMSession(refreshToken);

  if (!authResult.authenticated || !authResult.user) {
    const acceptHeader = req.headers.accept || "";
    const isBrowserRequest = acceptHeader.includes("text/html");

    if (isBrowserRequest) {
      // Session invalid - redirect to login
      const returnUrl = getRequestUrl(req);
      const loginUrl = getA2PMLoginUrl(returnUrl);
      sendRedirect(res, loginUrl);
      return true;
    } else {
      sendJsonError(res, 401, authResult.error || "Session expired. Please sign in again at A2PM.");
      return true;
    }
  }

  // Return the authenticated user for use by downstream handlers
  return authResult.user;
}
