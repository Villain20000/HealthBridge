import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle("HealthBridge OS REST API")
    .setDescription("Universal Medical Data Interoperability, Transformation, and Debugging Platform API")
    .setVersion("3.0.0")
    .addTag("medical-data")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`HealthBridge REST API running on http://localhost:${port}`);
  console.log(`OpenAPI documentation available at http://localhost:${port}/api/docs`);
}

bootstrap();
