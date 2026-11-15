import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser, TokenService } from '@nestjs/authentication';

import { ActivityService } from '../activity/activity.service.js';
import { hashPassword } from '../common/password.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  type CreateStaffDto,
  createStaffSchema,
  idParam,
  type UpdateStaffDto,
  updateStaffSchema,
} from './admin-auth.schemas.js';
import { type AdminPrincipal, adminSubject } from './auth.types.js';
import { AdminOnly, ROLE_GROUPS } from './roles.js';

const PUBLIC_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
} as const;

/** Staff accounts — owner only */
@Controller('admin/staff')
@AdminOnly(...ROLE_GROUPS.owner)
export class StaffController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  list() {
    return this.prisma.adminUser.findMany({
      select: PUBLIC_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  @Post()
  async create(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: createStaffSchema }) dto: CreateStaffDto,
  ) {
    const exists = await this.prisma.adminUser.findUnique({
      where: { email: dto.email },
    });
    if (exists)
      throw new ConflictException('This email already has an account');
    const created = await this.prisma.adminUser.create({
      data: {
        name: dto.name,
        email: dto.email,
        role: dto.role,
        passwordHash: await hashPassword(dto.password),
      },
      select: PUBLIC_FIELDS,
    });
    await this.activity.log(
      me,
      'staff.create',
      `Added ${dto.role.toLowerCase()} ${dto.name} (${dto.email})`,
    );
    return created;
  }

  @Patch(':id')
  async update(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: updateStaffSchema }) dto: UpdateStaffDto,
  ) {
    const target = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Staff member not found');

    const losesOwner =
      target.role === 'OWNER' &&
      ((dto.role && dto.role !== 'OWNER') || dto.active === false);
    if (losesOwner) {
      if (id === me.id) {
        throw new BadRequestException(
          'You cannot remove your own owner access',
        );
      }
      const owners = await this.prisma.adminUser.count({
        where: { role: 'OWNER', active: true },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'The shop needs at least one active owner',
        );
      }
    }

    const updated = await this.prisma.adminUser.update({
      where: { id },
      data: {
        name: dto.name,
        role: dto.role,
        active: dto.active,
        passwordHash: dto.password
          ? await hashPassword(dto.password)
          : undefined,
      },
      select: PUBLIC_FIELDS,
    });

    // Deactivated or password reset by the owner → sign them out everywhere
    if (dto.active === false || dto.password) {
      await this.tokens.revokeAll(adminSubject(id));
    }
    const changes = [
      dto.role && `role → ${dto.role}`,
      dto.active === false && 'deactivated',
      dto.active === true && 'activated',
      dto.password && 'password reset',
      dto.name && `name → ${dto.name}`,
    ].filter(Boolean);
    await this.activity.log(
      me,
      'staff.update',
      `${target.name}: ${changes.join(', ')}`,
    );
    return updated;
  }
}
