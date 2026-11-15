import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AdminPrincipal } from '../auth/auth.types.js';
import { ActivityService } from '../activity/activity.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CategoryInput } from './catalog.schemas.js';

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  image?: string;
  parentId: string | null;
  children?: CategoryNode[];
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** Active categories as a tree (top level → children), ordered for the menu */
  async tree(): Promise<CategoryNode[]> {
    const rows = await this.prisma.category.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const node = (c: (typeof rows)[number]): CategoryNode => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      image: c.image ?? undefined,
      parentId: c.parentId,
    });
    const parents = rows.filter((c) => !c.parentId);
    return parents.map((p) => {
      const children = rows.filter((c) => c.parentId === p.id).map(node);
      return { ...node(p), ...(children.length ? { children } : {}) };
    });
  }

  /** The category (and its parent, for breadcrumbs) by slug */
  async bySlug(slug: string) {
    const category = await this.prisma.category.findFirst({
      where: { slug, active: true },
      include: {
        parent: { select: { id: true, name: true, slug: true } },
        children: {
          where: { active: true },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true, slug: true, image: true },
        },
      },
    });
    if (!category) throw new NotFoundException('Category not found');
    const { parent, ...rest } = category;
    return { category: rest, parent: parent ?? undefined };
  }

  /** Ids of a category and its sub-categories (a parent page lists both) */
  async idsForSlug(slug: string): Promise<string[]> {
    const cat = await this.prisma.category.findFirst({
      where: { slug, active: true },
      select: { id: true, children: { select: { id: true } } },
    });
    return cat ? [cat.id, ...cat.children.map((c) => c.id)] : [];
  }

  // ───────── Admin ─────────

  async listAll() {
    const rows = await this.prisma.category.findMany({
      orderBy: [{ parentId: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    return rows.map(({ _count, ...c }) => ({
      ...c,
      productCount: _count.products,
    }));
  }

  async create(me: AdminPrincipal, dto: CategoryInput) {
    await this.assertValid(dto);
    const created = await this.prisma.category.create({ data: dto });
    await this.activity.log(
      me,
      'catalog.category',
      `Added category "${dto.name}"`,
    );
    return created;
  }

  async update(me: AdminPrincipal, id: string, dto: CategoryInput) {
    await this.get(id);
    await this.assertValid(dto, id);
    const updated = await this.prisma.category.update({
      where: { id },
      data: dto,
    });
    await this.activity.log(
      me,
      'catalog.category',
      `Updated category "${dto.name}"`,
    );
    return updated;
  }

  async remove(me: AdminPrincipal, id: string) {
    const cat = await this.get(id);
    const [products, children] = await Promise.all([
      this.prisma.product.count({ where: { categoryId: id } }),
      this.prisma.category.count({ where: { parentId: id } }),
    ]);
    if (products || children) {
      throw new ConflictException(
        `Move its ${products} product(s) and ${children} sub-categories first, or hide it instead`,
      );
    }
    await this.prisma.category.delete({ where: { id } });
    await this.activity.log(
      me,
      'catalog.category',
      `Deleted category "${cat.name}"`,
    );
  }

  private async get(id: string) {
    const cat = await this.prisma.category.findUnique({ where: { id } });
    if (!cat) throw new NotFoundException('Category not found');
    return cat;
  }

  /** Unique slug; only two levels (a parent cannot itself have a parent) */
  private async assertValid(dto: CategoryInput, id?: string) {
    const clash = await this.prisma.category.findFirst({
      where: { slug: dto.slug, NOT: id ? { id } : undefined },
      select: { id: true },
    });
    if (clash) throw new ConflictException('This slug is already used');
    if (!dto.parentId) return;
    if (dto.parentId === id) {
      throw new BadRequestException('A category cannot be its own parent');
    }
    const parent = await this.prisma.category.findUnique({
      where: { id: dto.parentId },
      select: { parentId: true },
    });
    if (!parent) throw new BadRequestException('Parent category not found');
    if (parent.parentId) {
      throw new BadRequestException('Only two levels: pick a top-level parent');
    }
    if (id && (await this.prisma.category.count({ where: { parentId: id } }))) {
      throw new BadRequestException(
        'This category has sub-categories, so it must stay top-level',
      );
    }
  }
}
