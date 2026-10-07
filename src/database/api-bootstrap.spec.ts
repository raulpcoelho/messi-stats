import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

describe('Serverless API initialization', () => {
  function appFixture() {
    const handler = jest.fn();
    return {
      useGlobalPipes: jest.fn(),
      enableCors: jest.fn(),
      init: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      getHttpAdapter: jest.fn(() => ({ getInstance: () => handler })),
      handler,
    };
  }

  beforeEach(() => {
    jest.spyOn(SwaggerModule, 'createDocument').mockReturnValue({} as any);
    jest.spyOn(SwaggerModule, 'setup').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function loadHandler() {
    const module = { exports: undefined as (req: any, res: any) => Promise<void> };
    const dependencies = {
      '@nestjs/core': { NestFactory },
      '@nestjs/common': { ValidationPipe },
      '@nestjs/swagger': { DocumentBuilder, SwaggerModule },
      '../dist/app.module': { AppModule: class {} },
    };
    runInNewContext(readFileSync(resolve(__dirname, '../../api/index.js'), 'utf8'), {
      module,
      require: (name: string) => {
        if (!dependencies[name]) throw new Error('Unexpected dependency');
        return dependencies[name];
      },
    });
    return module.exports;
  }

  it('waits for the same initialization before serving concurrent cold-start requests', async () => {
    const app = appFixture();
    let initialized: () => void;
    app.init.mockReturnValueOnce(
      new Promise<void>(resolve => {
        initialized = resolve;
      }),
    );
    const create = jest.spyOn(NestFactory, 'create').mockResolvedValue(app as any);
    const handler = loadHandler();
    const first = handler({}, {});
    const second = handler({}, {});
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    expect(app.handler).not.toHaveBeenCalled();
    initialized();
    await Promise.all([first, second]);
    expect(app.handler).toHaveBeenCalledTimes(2);
  });

  it('closes a failed application and retries initialization on the next request', async () => {
    const failed = appFixture();
    failed.init.mockRejectedValueOnce(new Error('Temporary connection failure'));
    const healthy = appFixture();
    const create = jest
      .spyOn(NestFactory, 'create')
      .mockResolvedValueOnce(failed as any)
      .mockResolvedValueOnce(healthy as any);
    const handler = loadHandler();
    await expect(handler({}, {})).rejects.toThrow('Temporary connection failure');
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(failed.handler).not.toHaveBeenCalled();
    await handler({}, {});
    expect(create).toHaveBeenCalledTimes(2);
    expect(healthy.handler).toHaveBeenCalledTimes(1);
  });
});
