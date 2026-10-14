import { Prisma } from '@prisma/client';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler, errorLogLines } from '../src/middleware/errorHandler';
import { dateOf, entryTypeOf, participantsOf } from '../src/services/qualitative/entryFields';

// A made-up name and note: database errors quote the values they were given.
const NAME = 'Fatima Ahmad Saleh';
const NOTE = `${NAME} of Beit Ummar said the distribution was late`;

function prismaValidationError(): Error {
  return new Prisma.PrismaClientValidationError(
    `Invalid \`prisma.qualitativeEntry.create()\` invocation:\n{\n  data: {\n    entryType: "interview",\n    title: "KII with ${NAME}",\n    content: "${NOTE}"\n  }\n}\nInvalid value for argument \`entryType\`.`,
    { clientVersion: Prisma.prismaVersion.client },
  );
}

function prismaKnownError(): Error {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on the value "${NAME}"`, {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
  });
}

describe('errorLogLines', () => {
  it('logs a database error by class name and code, never its message', () => {
    for (const production of [true, false]) {
      const validation = errorLogLines(prismaValidationError(), production).join('\n');
      expect(validation).toContain('Error: PrismaClientValidationError');
      expect(validation).not.toContain(NAME);
      expect(validation).not.toContain('Beit Ummar');

      const known = errorLogLines(prismaKnownError(), production).join('\n');
      expect(known).toContain('Error: PrismaClientKnownRequestError (P2002)');
      expect(known).not.toContain(NAME);
    }
  });

  it('keeps the stack frames outside production only', () => {
    expect(errorLogLines(prismaValidationError(), true)).toHaveLength(1);
    const dev = errorLogLines(prismaValidationError(), false);
    expect(dev).toHaveLength(2);
    expect(dev[1]).toMatch(/^\s+at /);
  });

  it("logs the API's own messages (AppError) as they are", () => {
    expect(errorLogLines(new AppError(400, 'entryType must be one of: a, b'), true)).toEqual(['Error: entryType must be one of: a, b']);
  });
});

describe('errorHandler', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['a Prisma validation error', prismaValidationError, 400],
    ['a Prisma unique constraint error', prismaKnownError, 409],
    // CC-03: a deadlock or write conflict with a simultaneous request is a 409 the client can repeat, never a 500.
    ['a Prisma write conflict (P2034)', () => new Prisma.PrismaClientKnownRequestError(`Transaction failed due to a write conflict or a deadlock (${NAME})`, {
      code: 'P2034', clientVersion: Prisma.prismaVersion.client,
    }), 409],
    ['a deadlock reported as an unknown request error (40P01)', () => new Prisma.PrismaClientUnknownRequestError(
      `Invalid \`prisma.kpiSuggestion.updateMany()\` invocation: Error occurred during query execution: ConnectorError(... code: "40P01", message: "deadlock detected" ... ${NAME})`,
      { clientVersion: Prisma.prismaVersion.client },
    ), 409],
    ['any other unknown request error', () => new Prisma.PrismaClientUnknownRequestError(`Something odd for ${NAME}`, { clientVersion: Prisma.prismaVersion.client }), 500],
    ['any other error', () => new Error(`Something failed for ${NAME}`), 500],
  ])('answers %s without logging what it quotes', async (_label, make, status) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.get('/boom', (_req, _res, next) => next(make()));
    app.use(errorHandler);

    const res = await request(app).get('/boom');
    expect(res.status).toBe(status);
    expect(JSON.stringify(res.body)).not.toContain(NAME);
    const logged = error.mock.calls.map(args => args.map(String).join(' ')).join('\n');
    expect(logged).not.toContain(NAME);
    expect(logged).not.toContain('Beit Ummar');
  });
});

describe('qualitative entry field checks', () => {
  it('accepts the known entry types and falls back when none is given', () => {
    expect(entryTypeOf('kii_notes', 'entryType')).toBe('kii_notes');
    expect(entryTypeOf(undefined, 'entry_type', 'field_notes')).toBe('field_notes');
    expect(entryTypeOf('', 'entry_type', 'field_notes')).toBe('field_notes');
    expect(() => entryTypeOf(undefined, 'entryType')).toThrow('entryType must be one of:');
    expect(() => entryTypeOf('KII', 'entryType')).toThrow('entryType must be one of:');
  });

  it('reads participants from numbers and digit strings only', () => {
    expect(participantsOf(undefined)).toBeUndefined();
    expect(participantsOf('')).toBeUndefined();
    expect(participantsOf(0)).toBe(0);
    expect(participantsOf(' 12 ')).toBe(12);
    expect(participantsOf(100_000)).toBe(100_000);
    for (const bad of [100_001, -1, 1.5, '1e3', '12 people', true, [], {}]) {
      expect(() => participantsOf(bad)).toThrow('participants must be a whole number from 0 to 100000');
    }
  });

  it('reads dates and refuses anything else, naming the field but never the value', () => {
    expect(dateOf(undefined, 'dateConducted')).toBeUndefined();
    expect(dateOf('2026-09-15', 'dateConducted')?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(dateOf('2026-09-15T10:20:00Z', '_submission_time')?.toISOString()).toBe('2026-09-15T10:20:00.000Z');
    expect(() => dateOf(`met ${NAME}`, 'dateConducted')).toThrow(/^dateConducted must be a date$/);
    expect(() => dateOf(20260915, 'dateConducted')).toThrow('dateConducted must be a date');
  });
});
