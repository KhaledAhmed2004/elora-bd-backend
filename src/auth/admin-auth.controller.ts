import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import {
  type ChangePasswordDto,
  changePasswordSchema,
  type LoginDto,
  loginSchema,
} from './admin-auth.schemas.js';
import { AdminAuthService } from './admin-auth.service.js';
import type { AdminPrincipal } from './auth.types.js';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie.js';
import { AdminOnly } from './roles.js';

@Controller('admin/auth')
@UseGuards(ThrottlerGuard)
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  /** 5 tries per minute per IP — slows password guessing */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginSchema }) body: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { tokens, admin } = await this.auth.login(body);
    setRefreshCookie(res, tokens.refreshToken);
    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      admin,
    };
  }

  /** New access token from the refresh cookie (called on page load and before expiry) */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = readRefreshCookie(req);
    if (!token) throw new UnauthorizedException('Not signed in');
    try {
      const { tokens, admin } = await this.auth.refresh(token);
      setRefreshCookie(res, tokens.refreshToken);
      return {
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        admin,
      };
    } catch (e) {
      clearRefreshCookie(res);
      throw e;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res);
  }

  @AdminOnly()
  @Get('me')
  me(@CurrentUser() user: AdminPrincipal) {
    return user;
  }

  @AdminOnly()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AdminPrincipal,
    @Body({ schema: changePasswordSchema }) body: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.changePassword(user, body);
    setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }
}
