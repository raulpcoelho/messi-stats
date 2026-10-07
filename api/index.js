const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { ValidationPipe } = require('@nestjs/common');
const { DocumentBuilder, SwaggerModule } = require('@nestjs/swagger');

let appPromise;

async function initialize() {
  let app;
  try {
    app = await NestFactory.create(AppModule, { abortOnError: false });

    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        forbidNonWhitelisted: false,
        whitelist: true,
      }),
    );

    const description =
      'This is an API that provides detailed statistics for all matches played by Lionel Messi. You can filter the data by year, opponents, season, competition, and others to get specific insights. The data is updated regularly as Messi plays new matches.';

    const config = new DocumentBuilder()
      .setTitle('Messi Stats API')
      .setDescription(description)
      .setVersion('1.0.0')
      .setContact('Raul Coelho', 'https://www.github.com/raulpcoelho', 'rpc3@cin.ufpe.br')
      .setLicense('Apache 2.0', 'https://www.apache.org/licenses/LICENSE-2.0')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('/api/docs', app, document, {
      customSiteTitle: 'Lionel Messi Stats',
      customfavIcon: '/favicon.png',
    });

    app.enableCors({
      origin: '*',
    });

    await app.init();
    return app;
  } catch (error) {
    if (app) await app.close().catch(() => {});
    throw error;
  }
}

function bootstrap() {
  if (!appPromise) {
    appPromise = initialize().catch(error => {
      appPromise = undefined;
      throw error;
    });
  }
  return appPromise;
}

module.exports = async (req, res) => {
  const server = await bootstrap();
  server.getHttpAdapter().getInstance()(req, res);
};
