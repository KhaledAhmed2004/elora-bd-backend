import { Global, Injectable, Logger, Module } from '@nestjs/common';

import type { AdminPrincipal } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Server-side audit log ("who changed what"), shown on the admin Activity page */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never throws: a failed log line must not fail the action it describes */
  async log(
    actor: Pick<AdminPrincipal, 'id' | 'name'> | null,
    action: string,
    message: string,
    href?: string,
  ) {
    try {
      await this.prisma.activityLog.create({
        data: {
          adminId: actor?.id ?? null,
          actorName: actor?.name ?? 'System',
          action,
          message,
          href,
        },
      });
    } catch (e) {
      this.logger.error(`Could not write activity "${action}"`, e as Error);
    }
  }
}

@Global()
@Module({ providers: [ActivityService], exports: [ActivityService] })
export class ActivityModule {}
