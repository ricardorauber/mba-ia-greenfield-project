import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { configModuleOptions } from './config/config-module.options';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    DatabaseModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
