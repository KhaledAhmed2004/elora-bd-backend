import type { CookieOptions, Request, Response } from 'express';

/**
 * The refresh token lives in an httpOnly cookie (JavaScript can't read it, so
 * an XSS bug can't steal it). The short-lived access token is kept in memory
 * by the admin app and sent as `Authorization: Bearer`.
 */
export const ADMIN_REFRESH_COOKIE = 'bd_admin_rt';

/**
 * 'lax' works when the shop and the API share a site (localhost, or
 * shop.com + api.shop.com). Set COOKIE_SAMESITE=none when they are on
 * unrelated domains, otherwise the browser never sends the cookie back.
 */
const sameSite = (): CookieOptions['sameSite'] =>
  process.env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax';

const options = (): CookieOptions => ({
  httpOnly: true,
  // SameSite=None is only accepted by browsers on Secure cookies
  secure: process.env.NODE_ENV === 'production' || sameSite() === 'none',
  sameSite: sameSite(),
  // Sent only to the auth endpoints, never to the rest of the API
  path: '/api/admin/auth',
  maxAge: 30 * 24 * 60 * 60 * 1000,
});

export function setRefreshCookie(res: Response, token: string) {
  res.cookie(ADMIN_REFRESH_COOKIE, token, options());
}

export function clearRefreshCookie(res: Response) {
  const { maxAge: _maxAge, ...rest } = options();
  res.clearCookie(ADMIN_REFRESH_COOKIE, rest);
}

export function readRefreshCookie(req: Request): string | undefined {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[
    ADMIN_REFRESH_COOKIE
  ];
  return typeof value === 'string' && value ? value : undefined;
}
