import { Module } from "@nestjs/common";
import { ApiController } from "./api.controller.js";

@Module({
  imports: [],
  controllers: [ApiController],
  providers: [],
})
export class AppModule {}
