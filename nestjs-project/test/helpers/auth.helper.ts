import { randomUUID } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { JwtPayload } from '../../src/auth/auth.types';
import { MailService } from '../../src/mail/mail.service';

const DEFAULT_PASSWORD = 'password123';

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  access_token: string;
}

/** Registers the user and returns the raw confirmation token instead of mailing it. */
export async function captureConfirmationToken(
  app: INestApplication<App>,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<string> {
  // Same singleton AuthService holds, so the spy intercepts its call
  const mailService = app.get(MailService);
  let capturedToken = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_e: string, _n: string, t: string) => {
      capturedToken = t;
      return Promise.resolve();
    });
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password });
  return capturedToken;
}

export async function registerConfirmAndLogin(
  app: INestApplication<App>,
  email: string,
  password = DEFAULT_PASSWORD,
): Promise<AuthTokens> {
  const token = await captureConfirmationToken(app, email, password);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token });
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password });
  const body = res.body as AuthTokens;
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
  };
}

/**
 * Confirmed user (registration also creates its channel) with a valid access
 * token. Makes 3 auth requests: suites calling it repeatedly must clear the
 * throttler storage between tests.
 */
export async function createAuthenticatedUser(
  app: INestApplication<App>,
  email = `user-${randomUUID()}@example.com`,
): Promise<AuthenticatedUser> {
  const { access_token } = await registerConfirmAndLogin(app, email);
  const payload = JSON.parse(
    Buffer.from(access_token.split('.')[1], 'base64url').toString(),
  ) as JwtPayload;
  return { userId: payload.sub, email, access_token };
}
