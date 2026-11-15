import { Module } from '@nestjs/common';

import { AdminAuthController } from './admin-auth.controller.js';
import { AdminAuthService } from './admin-auth.service.js';
import { JwtAuthProvider } from './jwt-auth.provider.js';
import { PrismaRefreshTokenStore } from './prisma-refresh-token.store.js';
import { AdminRolesGuard } from './roles.js';
import { StaffController } from './staff.controller.js';

@Module({
  controllers: [AdminAuthController, StaffController],
  providers: [
    PrismaRefreshTokenStore,
    JwtAuthProvider,
    AdminAuthService,
    AdminRolesGuard,
  ],
})
export class AuthModule {}
