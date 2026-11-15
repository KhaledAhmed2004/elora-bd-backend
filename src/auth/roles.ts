import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AdminRole } from '../generated/prisma/enums.js';
import type { AuthUser } from './auth.types.js';

const ROLES_KEY = 'admin:roles';

/**
 * What each role may do. OWNER can do everything.
 *  - MANAGER: orders, catalog, customers, reports, purchases (not staff/settings)
 *  - STAFF:   orders, calls, customers (no catalog edits, no money reports)
 */
export const ROLE_GROUPS = {
  owner: ['OWNER'],
  manager: ['OWNER', 'MANAGER'],
  staff: ['OWNER', 'MANAGER', 'STAFF'],
} as const satisfies Record<string, readonly AdminRole[]>;

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<readonly AdminRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    // The global AuthenticationGuard has already rejected anonymous calls
    const user = context.switchToHttp().getRequest<{ user?: AuthUser }>().user;
    if (user?.kind !== 'admin') {
      throw new ForbiddenException('Admin access only');
    }
    if (allowed && !allowed.includes(user.role)) {
      throw new ForbiddenException('Your role cannot do this');
    }
    return true;
  }
}

/**
 * Admin-only route/controller. With no roles: any active admin or staff.
 * @example @AdminOnly(...ROLE_GROUPS.manager)
 */
export const AdminOnly = (...roles: AdminRole[]) =>
  applyDecorators(
    SetMetadata(ROLES_KEY, roles.length ? roles : undefined),
    UseGuards(AdminRolesGuard),
  );
