import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { DatabaseModule } from './database.module';

describe('DatabaseModule', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(configModuleOptions), DatabaseModule],
    }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('should initialize the DataSource from the shared config options', () => {
    const dataSource = module.get(DataSource);

    expect(dataSource.isInitialized).toBe(true);
  });

  it('should run queries against the db service', async () => {
    const dataSource = module.get(DataSource);

    const rows: Array<{ result: number }> =
      await dataSource.query('SELECT 1 AS result');

    expect(rows).toEqual([{ result: 1 }]);
  });
});
