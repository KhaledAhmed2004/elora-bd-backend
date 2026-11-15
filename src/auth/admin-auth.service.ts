import { Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenService } from '@nestjs/authentication';

import { ActivityService } from '../activity/activity.service.js';
import { hashPassword, verifyPassword } from '../common/password.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ChangePasswordDto, LoginDto } from './admin-auth.schemas.js';
import { type AdminPrincipal, adminSubject } from './auth.types.js';

// Compared against when the email is unknown, so both paths take the same time
const DUMMY_HASH = await hashPassword('timing-equaliser-not-a-real-password');

const INVALID = 'Email or password is incorrect';

export const toPrincipal = (a: {
  id: string;
  name: string;
  email: string;
  role: AdminPrincipal['role'];
}): AdminPrincipal => ({
  kind: 'admin',
  id: a.id,
  name: a.name,
  email: a.email,
  role: a.role,
});

/** Reads `sub` from an access token this server just signed (no verification needed) */
function subjectOf(accessToken: string): string | undefined {
  const payload = accessToken.split('.')[1];
  if (!payload) return undefined;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    sub?: string;
  };
  return claims.sub;
}

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly activity: ActivityService,
  ) {}

  async login({ email, password }: LoginDto) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    const ok = await verifyPassword(
      password,
      admin?.passwordHash ?? DUMMY_HASH,
    );
    if (!admin || !ok || !admin.active)
      throw new UnauthorizedException(INVALID);

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });
    const principal = toPrincipal(admin);
    await this.activity.log(principal, 'auth.login', `${admin.name} signed in`);
    const tokens = await this.tokens.issue(adminSubject(admin.id), {
      method: 'password',
      claims: { amr: ['pwd'] },
    });
    return { tokens, admin: principal };
  }

  /** Rotates the refresh token. A deactivated admin cannot refresh. */
  async refresh(refreshToken: string) {
    const tokens = await this.tokens.refresh(refreshToken);
    const sub = subjectOf(tokens.accessToken);
    const admin = sub?.startsWith('admin:')
      ? await this.prisma.adminUser.findUnique({
          where: { id: sub.slice('admin:'.length) },
        })
      : null;
    if (!admin?.active) {
      await this.tokens.revoke(tokens.refreshToken);
      throw new UnauthorizedException('Session ended');
    }
    return { tokens, admin: toPrincipal(admin) };
  }

  async logout(refreshToken: string | undefined) {
    if (refreshToken) await this.tokens.revoke(refreshToken);
  }

  /** Changes the password and signs out every other device */
  async changePassword(user: AdminPrincipal, dto: ChangePasswordDto) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: user.id },
    });
    if (!(await verifyPassword(dto.currentPassword, admin.passwordHash))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(dto.newPassword) },
    });
    await this.tokens.revokeAll(adminSubject(user.id));
    await this.activity.log(
      user,
      'auth.password',
      `${user.name} changed their password`,
    );
    return this.tokens.issue(adminSubject(user.id), {
      method: 'password',
      claims: { amr: ['pwd'] },
    });
  }
}
