import { Module } from '@nestjs/common';
import { AuthenticationModule } from '@nestjs/authentication';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

import { AccountsModule } from './accounts/accounts.module.js';
import { CustomersModule } from './customers/customers.module.js';
import { LeadsModule } from './leads/leads.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { ActivityModule } from './activity/activity.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogModule } from './catalog/catalog.module.js';
import { type Env, validateEnv } from './config/env.js';
import { HealthController } from './health/health.controller.js';
import { OrdersModule } from './orders/orders.module.js';
import { PopupsModule } from './popups/popups.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { SettingsModule } from './settings/settings.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    // Global guard: every route needs a signed-in user unless marked @Public()
    AuthenticationModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        accessToken: {
          key: config.get('JWT_ACCESS_SECRET', { infer: true }),
          issuer: 'bdshop-api',
          audience: 'bdshop',
          ttl: '15m',
        },
        refreshToken: { ttl: '30d', absoluteTtl: '90d' },
      }),
    }),
    // Limits are set per route with @Throttle (login, OTP, checkout)
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    ActivityModule,
    SettingsModule,
    AuthModule,
    CatalogModule,
    OrdersModule,
    ReviewsModule,
    LeadsModule,
    CustomersModule,
    AccountsModule,
    ReportsModule,
    PopupsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
