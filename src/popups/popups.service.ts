import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PopupEvent, PopupInput } from './popups.schemas.js';

/** What the storefront needs: no counters, no internal name */
const PUBLIC_FIELDS = {
  id: true,
  badge: true,
  title: true,
  subtitle: true,
  image: true,
  cta: true,
  href: true,
  couponCode: true,
  layout: true,
  trigger: true,
  delaySeconds: true,
  scrollPercent: true,
  frequency: true,
  pages: true,
  device: true,
  startsAt: true,
  endsAt: true,
  showCountdown: true,
  priority: true,
} as const;

const ACTION = 'marketing.popup';
const HREF = '/admin/popups';

@Injectable()
export class PopupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /**
   * Switched-on popups that have not ended. Scheduled ones (startsAt in the
   * future) are included so a cached copy can start them on time; the
   * browser checks startsAt/endsAt again before showing anything.
   */
  live() {
    return this.prisma.popup.findMany({
      where: {
        active: true,
        OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      select: PUBLIC_FIELDS,
      take: 20,
    });
  }

  /** Counts a view or a button click. Unknown ids are ignored. */
  async track(id: string, { type }: PopupEvent) {
    await this.prisma.popup.updateMany({
      where: { id },
      data:
        type === 'view'
          ? { views: { increment: 1 } }
          : { clicks: { increment: 1 } },
    });
  }

  listAll() {
    return this.prisma.popup.findMany({
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async create(me: AdminPrincipal, dto: PopupInput) {
    await this.checkCoupon(dto.couponCode);
    const created = await this.prisma.popup.create({ data: dto });
    await this.activity.log(me, ACTION, `Added popup "${dto.name}"`, HREF);
    return created;
  }

  async update(me: AdminPrincipal, id: string, dto: PopupInput) {
    await this.get(id);
    await this.checkCoupon(dto.couponCode);
    const updated = await this.prisma.popup.update({
      where: { id },
      data: dto,
    });
    await this.activity.log(me, ACTION, `Updated popup "${dto.name}"`, HREF);
    return updated;
  }

  async setActive(me: AdminPrincipal, id: string, active: boolean) {
    const p = await this.get(id);
    const updated = await this.prisma.popup.update({
      where: { id },
      data: { active },
    });
    await this.activity.log(
      me,
      ACTION,
      `${active ? 'Turned on' : 'Turned off'} popup "${p.name}"`,
      HREF,
    );
    return updated;
  }

  /** Same settings, switched off, counters at zero */
  async duplicate(me: AdminPrincipal, id: string) {
    const source = await this.get(id);
    const copy = await this.prisma.popup.create({
      data: {
        name: `${source.name} (copy)`.slice(0, 80),
        badge: source.badge,
        title: source.title,
        subtitle: source.subtitle,
        image: source.image,
        cta: source.cta,
        href: source.href,
        couponCode: source.couponCode,
        layout: source.layout,
        trigger: source.trigger,
        delaySeconds: source.delaySeconds,
        scrollPercent: source.scrollPercent,
        frequency: source.frequency,
        pages: source.pages,
        device: source.device,
        startsAt: source.startsAt,
        endsAt: source.endsAt,
        showCountdown: source.showCountdown,
        priority: source.priority,
        active: false,
      },
    });
    await this.activity.log(
      me,
      ACTION,
      `Duplicated popup "${source.name}"`,
      HREF,
    );
    return copy;
  }

  async resetStats(me: AdminPrincipal, id: string) {
    const p = await this.get(id);
    const updated = await this.prisma.popup.update({
      where: { id },
      data: { views: 0, clicks: 0 },
    });
    await this.activity.log(
      me,
      ACTION,
      `Reset stats of popup "${p.name}"`,
      HREF,
    );
    return updated;
  }

  async remove(me: AdminPrincipal, id: string) {
    const p = await this.get(id);
    await this.prisma.popup.delete({ where: { id } });
    await this.activity.log(me, ACTION, `Deleted popup "${p.name}"`, HREF);
  }

  private async checkCoupon(code: string | null) {
    if (!code) return;
    const found = await this.prisma.coupon.findUnique({ where: { code } });
    if (!found) {
      throw new BadRequestException(
        `Coupon "${code}" does not exist. Create it under Coupons first.`,
      );
    }
  }

  private async get(id: string) {
    const p = await this.prisma.popup.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Popup not found');
    return p;
  }
}
