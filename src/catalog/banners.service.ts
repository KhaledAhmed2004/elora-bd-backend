import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { BannerInput } from './catalog.schemas.js';

@Injectable()
export class BannersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** Home hero slider */
  active() {
    return this.prisma.banner.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        title: true,
        subtitle: true,
        cta: true,
        href: true,
        image: true,
      },
    });
  }

  listAll() {
    return this.prisma.banner.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  async create(me: AdminPrincipal, dto: BannerInput) {
    const last = await this.prisma.banner.aggregate({
      _max: { sortOrder: true },
    });
    const created = await this.prisma.banner.create({
      data: { ...dto, sortOrder: (last._max.sortOrder ?? -1) + 1 },
    });
    await this.activity.log(
      me,
      'catalog.banner',
      `Added banner "${dto.title}"`,
    );
    return created;
  }

  async update(me: AdminPrincipal, id: string, dto: BannerInput) {
    await this.get(id);
    const updated = await this.prisma.banner.update({
      where: { id },
      data: dto,
    });
    await this.activity.log(
      me,
      'catalog.banner',
      `Updated banner "${dto.title}"`,
    );
    return updated;
  }

  async remove(me: AdminPrincipal, id: string) {
    const b = await this.get(id);
    await this.prisma.banner.delete({ where: { id } });
    await this.activity.log(
      me,
      'catalog.banner',
      `Deleted banner "${b.title}"`,
    );
  }

  /** New order = the given ids, first shown first */
  async reorder(me: AdminPrincipal, ids: string[]) {
    const count = await this.prisma.banner.count({
      where: { id: { in: ids } },
    });
    if (count !== ids.length || new Set(ids).size !== ids.length) {
      throw new BadRequestException('Unknown or repeated banner ids');
    }
    await this.prisma.$transaction(
      ids.map((id, i) =>
        this.prisma.banner.update({ where: { id }, data: { sortOrder: i } }),
      ),
    );
    await this.activity.log(me, 'catalog.banner', 'Reordered home banners');
    return this.listAll();
  }

  private async get(id: string) {
    const b = await this.prisma.banner.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Banner not found');
    return b;
  }
}
