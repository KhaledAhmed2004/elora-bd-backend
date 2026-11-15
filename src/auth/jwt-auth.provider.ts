import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  JwtBearerProvider,
  type JwtClaims,
} from '@nestjs/authentication';

import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth.types.js';

/**
 * Verifies `Authorization: Bearer <access token>` and loads the user.
 * Role and "active" are read from the database on every request, so
 * deactivating a staff member or changing a role takes effect immediately.
 */
@Injectable()
export class JwtAuthProvider extends JwtBearerProvider<AuthUser> {
  constructor(
    private readonly prisma: PrismaService,
    registry: AuthenticationRegistry,
  ) {
    super();
    registry.registerProvider(this);
  }

  async validate({ sub }: JwtClaims): Promise<AuthUser | null> {
    if (!sub?.startsWith('admin:')) return null;
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: sub.slice('admin:'.length) },
      select: { id: true, name: true, email: true, role: true, active: true },
    });
    if (!admin?.active) return null;
    return {
      kind: 'admin',
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
    };
  }
}
