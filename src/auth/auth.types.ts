import type { AdminRole } from '../generated/prisma/enums.js';

/** The signed-in admin/staff member, loaded fresh from the database on every request */
export interface AdminPrincipal {
  kind: 'admin';
  id: string;
  name: string;
  email: string;
  role: AdminRole;
}

/** Customers (phone OTP) are added in the storefront step */
export type AuthUser = AdminPrincipal;

declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: AuthUser;
  }
}

/** Token subject: "admin:<id>" — keeps admin and customer ids apart */
export const adminSubject = (id: string) => `admin:${id}`;
