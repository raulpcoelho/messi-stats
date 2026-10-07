import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { TypeOrmService } from './typeorm.service';

describe('Database connection lifecycle', () => {
  const previousSize = process.env.TYPEORM_POOL_SIZE;

  afterEach(() => {
    if (previousSize === undefined) delete process.env.TYPEORM_POOL_SIZE;
    else process.env.TYPEORM_POOL_SIZE = previousSize;
    jest.restoreAllMocks();
  });

  it('initializes a single shared database pool across API modules', async () => {
    const initialize = jest.spyOn(TypeOrmService.prototype, 'initialize').mockResolvedValue(undefined);
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.init();
    expect(initialize).toHaveBeenCalledTimes(1);
    await module.close();
  });

  it('limits the pool and connection acquisition time by default', () => {
    delete process.env.TYPEORM_POOL_SIZE;
    expect(new TypeOrmService().options).toMatchObject({ poolSize: 3, connectTimeoutMS: 10000 });
  });

  it('accepts an explicitly configured pool size', () => {
    process.env.TYPEORM_POOL_SIZE = '2';
    expect(new TypeOrmService().options).toMatchObject({ poolSize: 2 });
  });

  it.each(['0', '-1', '2oops', '1.5'])('rejects an invalid pool size: %s', value => {
    process.env.TYPEORM_POOL_SIZE = value;
    expect(() => new TypeOrmService()).toThrow('TYPEORM_POOL_SIZE must be a positive integer.');
  });

  it('destroys an initialized pool when the application closes', async () => {
    const database = new TypeOrmService();
    Object.defineProperty(database, 'isInitialized', { value: true });
    const destroy = jest.spyOn(database, 'destroy').mockResolvedValue(undefined);
    await database.onApplicationShutdown();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
