import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { createTestApp } from './helpers.js';

describe('Health (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  it('GET /api/health is public and reports the database as up', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  afterAll(async () => {
    await app.close();
  });
});
