import { z } from 'zod';

const email = z
  .email('Enter a valid email')
  .max(120)
  .transform((e) => e.trim().toLowerCase());

/** 10+ chars with a letter and a number — staff accounts can see customer data */
export const newPasswordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Add at least one letter')
  .regex(/\d/, 'Add at least one number');

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Enter your password').max(128),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: newPasswordSchema,
});
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

const role = z.enum(['OWNER', 'MANAGER', 'STAFF']);

export const createStaffSchema = z.object({
  name: z.string().trim().min(2).max(60),
  email,
  role,
  password: newPasswordSchema,
});
export type CreateStaffDto = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    role,
    active: z.boolean(),
    password: newPasswordSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateStaffDto = z.infer<typeof updateStaffSchema>;

export const idParam = z.string().min(1).max(40);
