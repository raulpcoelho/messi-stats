import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { StatsSyncController } from './stats-sync.controller';
import { StatsSyncGuard } from './stats-sync.guard';
import { StatsSyncService } from './stats-sync.service';

describe('Stats sync HTTP authorization', () => {
  let app: INestApplication;
  const previousToken = process.env.STATS_SYNC_TOKEN;
  const service = { sync: jest.fn() };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StatsSyncController],
      providers: [StatsSyncGuard, { provide: StatsSyncService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    process.env.STATS_SYNC_TOKEN = 'test-update-secret';
    service.sync.mockReset();
  });

  afterAll(async () => {
    if (previousToken === undefined) delete process.env.STATS_SYNC_TOKEN;
    else process.env.STATS_SYNC_TOKEN = previousToken;
    await app.close();
  });

  it('disables the endpoint when the server has no key', async () => {
    delete process.env.STATS_SYNC_TOKEN;
    await request(app.getHttpServer()).post('/admin/stats/sync').expect(503);
    expect(service.sync).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong', 'Basic test-update-secret', 'Bearer '])(
    'rejects unauthorized requests before fetching or writing',
    async authorization => {
      const call = request(app.getHttpServer()).post('/admin/stats/sync');
      if (authorization) call.set('Authorization', authorization);
      await call.expect(401);
      expect(service.sync).not.toHaveBeenCalled();
    },
  );

  it('accepts an authorized POST and returns the committed import counts', async () => {
    const result = { fetched: 3, inserted: 1, updated: 1, unchanged: 1 };
    service.sync.mockResolvedValue(result);
    await request(app.getHttpServer())
      .post('/admin/stats/sync')
      .set('Authorization', 'Bearer test-update-secret')
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect(result);
    expect(service.sync).toHaveBeenCalledTimes(1);
  });

  it('does not offer a GET write endpoint', async () => {
    await request(app.getHttpServer()).get('/admin/stats/sync').expect(404);
    expect(service.sync).not.toHaveBeenCalled();
  });
});
