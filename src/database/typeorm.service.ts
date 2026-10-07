import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';

config(); // use dotenv to make sure the environment variables are loaded before using it.

@Injectable()
export class TypeOrmService extends DataSource implements OnModuleInit, OnApplicationShutdown {
  constructor() {
    const poolSize = Number(process.env.TYPEORM_POOL_SIZE ?? 3);
    if (!Number.isSafeInteger(poolSize) || poolSize < 1) {
      throw new Error('TYPEORM_POOL_SIZE must be a positive integer.');
    }
    super({
      type: 'postgres',
      host: process.env.TYPEORM_HOST,
      port: parseInt(process.env.TYPEORM_PORT),
      username: process.env.TYPEORM_USERNAME,
      password: process.env.TYPEORM_PASSWORD,
      database: process.env.TYPEORM_DATABASE,
      poolSize,
      connectTimeoutMS: 10000,
      ...(process.env.ENVIRONMENT === 'production' && {
        ssl: true,
        extra: {
          ssl: {
            rejectUnauthorized: false,
          },
        },
      }),
      entities: [process.env.TYPEORM_ENTITIES],
      migrations: [process.env.TYPEORM_MIGRATIONS, process.env.TYPEORM_SEEDS],
      synchronize: false,
      logging: false,
    });
  }

  async onModuleInit() {
    await this.initialize();
  }

  async onApplicationShutdown() {
    if (this.isInitialized) await this.destroy();
  }
}

const typeOrmService = new TypeOrmService();
export default typeOrmService;
