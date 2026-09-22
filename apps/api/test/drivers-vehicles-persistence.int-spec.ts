import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DUMMY_PASSWORD_HASH } from '../src/auth/password.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Synthetic identities only; every row this file creates is scoped by prefix.
const PREFIX = 'stage4a-';
const EMAIL = `${PREFIX}driver@example.test`;
const EMAIL_2 = `${PREFIX}second@example.test`;
const PLATE = 'S4A 0001';
const PLATE_PREFIX = 'S4A ';
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function driverData(
  suffix: string,
  extra: Partial<Prisma.DriverUncheckedCreateInput> = {},
): Prisma.DriverUncheckedCreateInput {
  return {
    fullName: `${PREFIX}${suffix}`,
    phone: '+63 900 000 0000',
    licenceNumber: `${PREFIX}LIC-${suffix}`,
    ...extra,
  };
}

function vehicleData(
  plate: string,
  extra: Partial<Prisma.VehicleUncheckedCreateInput> = {},
): Prisma.VehicleUncheckedCreateInput {
  return {
    plateNumber: plate,
    make: 'Synthetic',
    model: 'Hauler',
    year: 2020,
    ...extra,
  };
}

function prismaCode(error: unknown): string | null {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code
    : null;
}

describe('drivers & vehicles persistence (mansar_test)', () => {
  let prisma: PrismaService;

  async function cleanup(): Promise<void> {
    // Drivers first: a linked driver blocks its user's deletion (RESTRICT).
    await prisma.driver.deleteMany({
      where: { fullName: { startsWith: PREFIX } },
    });
    await prisma.vehicle.deleteMany({
      where: { plateNumber: { startsWith: PLATE_PREFIX, mode: 'insensitive' } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  }

  async function createUser(email = EMAIL): Promise<string> {
    const user = await prisma.user.create({
      data: { email, passwordHash: DUMMY_PASSWORD_HASH, role: 'DRIVER' },
      select: { id: true },
    });
    return user.id;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await cleanup();
  });

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await prisma.onModuleDestroy();
  });

  it('A. catalog: enums, unique indexes, FK rules and the date column are as designed', async () => {
    const enums = await prisma.$queryRaw<{ typname: string; label: string }[]>`
      SELECT t.typname, e.enumlabel AS label FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname IN ('driver_status', 'vehicle_status')
      ORDER BY t.typname, e.enumsortorder`;
    expect(
      enums.filter((e) => e.typname === 'driver_status').map((e) => e.label),
    ).toEqual(['ACTIVE', 'INACTIVE']);
    expect(
      enums.filter((e) => e.typname === 'vehicle_status').map((e) => e.label),
    ).toEqual(['ACTIVE', 'IN_MAINTENANCE', 'RETIRED']);

    const indexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('drivers', 'vehicles')
      ORDER BY indexname`;
    expect(indexes.map((i) => i.indexname)).toEqual([
      'drivers_pkey',
      'drivers_user_id_key',
      'vehicles_pkey',
      'vehicles_plate_number_key',
    ]);

    const fks = await prisma.$queryRaw<
      { constraint_name: string; delete_rule: string; update_rule: string }[]
    >`
      SELECT constraint_name, delete_rule, update_rule
      FROM information_schema.referential_constraints
      WHERE constraint_name = 'drivers_user_id_fkey'`;
    expect(fks).toEqual([
      {
        constraint_name: 'drivers_user_id_fkey',
        delete_rule: 'RESTRICT',
        update_rule: 'NO ACTION',
      },
    ]);

    const columns = await prisma.$queryRaw<
      { column_name: string; data_type: string; is_nullable: string }[]
    >`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'drivers'
        AND column_name IN ('user_id', 'licence_expiry', 'notes', 'created_at')
      ORDER BY column_name`;
    expect(columns).toEqual([
      {
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      { column_name: 'licence_expiry', data_type: 'date', is_nullable: 'YES' },
      { column_name: 'notes', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'user_id', data_type: 'uuid', is_nullable: 'YES' },
    ]);
  });

  it('B. driver defaults: UUID v7 id, ACTIVE, empty notes, no login, no expiry', async () => {
    const driver = await prisma.driver.create({ data: driverData('one') });

    expect(driver.id).toMatch(UUID_V7);
    expect(driver.status).toBe('ACTIVE');
    expect(driver.notes).toBe('');
    expect(driver.userId).toBeNull();
    expect(driver.licenceExpiry).toBeNull();
    expect(driver.createdAt).toBeInstanceOf(Date);
    expect(driver.updatedAt).toBeInstanceOf(Date);
  });

  it('C. several drivers may exist without a login (user_id NULL is not unique)', async () => {
    await prisma.driver.create({ data: driverData('one') });
    await prisma.driver.create({ data: driverData('two') });
    await prisma.driver.create({ data: driverData('three') });

    const unlinked = await prisma.driver.count({
      where: { fullName: { startsWith: PREFIX }, userId: null },
    });
    expect(unlinked).toBe(3);
  });

  it('D. one login cannot be linked to two drivers', async () => {
    const userId = await createUser();
    await prisma.driver.create({ data: driverData('one', { userId }) });

    let code: string | null = null;
    try {
      await prisma.driver.create({ data: driverData('two', { userId }) });
    } catch (error) {
      code = prismaCode(error);
    }
    expect(code).toBe('P2002');
    expect(await prisma.driver.count({ where: { userId } })).toBe(1);

    // A different login is still linkable to a different driver.
    const otherUserId = await createUser(EMAIL_2);
    await expect(
      prisma.driver.create({
        data: driverData('two', { userId: otherUserId }),
      }),
    ).resolves.toMatchObject({ userId: otherUserId });
  });

  it('E. deleting a login that is linked to a driver is rejected by the FK', async () => {
    const userId = await createUser();
    const driver = await prisma.driver.create({
      data: driverData('one', { userId }),
    });

    let code: string | null = null;
    try {
      await prisma.user.delete({ where: { id: userId } });
    } catch (error) {
      code = prismaCode(error);
    }
    expect(code).toBe('P2003');
    expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
    await expect(
      prisma.driver.findUnique({ where: { id: driver.id } }),
    ).resolves.toMatchObject({ userId });

    // Unlinking first makes the deletion possible.
    await prisma.driver.update({
      where: { id: driver.id },
      data: { userId: null },
    });
    await expect(
      prisma.user.delete({ where: { id: userId }, select: { id: true } }),
    ).resolves.toEqual({ id: userId });
  });

  it('F. licence_expiry round-trips as a calendar date', async () => {
    const driver = await prisma.driver.create({
      data: driverData('one', {
        licenceExpiry: new Date('2027-03-31T00:00:00.000Z'),
      }),
      select: { id: true, licenceExpiry: true },
    });
    expect(driver.licenceExpiry?.toISOString()).toBe(
      '2027-03-31T00:00:00.000Z',
    );

    const [stored] = await prisma.$queryRaw<{ text: string }[]>`
      SELECT licence_expiry::text AS text FROM drivers
      WHERE id = ${driver.id}::uuid`;
    expect(stored?.text).toBe('2027-03-31');
  });

  it('G. vehicle defaults: UUID v7 id, ACTIVE, empty notes, no odometer', async () => {
    const vehicle = await prisma.vehicle.create({ data: vehicleData(PLATE) });

    expect(vehicle.id).toMatch(UUID_V7);
    expect(vehicle.status).toBe('ACTIVE');
    expect(vehicle.notes).toBe('');
    expect(vehicle.currentOdometer).toBeNull();
    expect(vehicle.year).toBe(2020);
    expect(vehicle.createdAt).toBeInstanceOf(Date);
    expect(vehicle.updatedAt).toBeInstanceOf(Date);
  });

  it('H. a duplicate stored plate is rejected; uniqueness is on the stored value only', async () => {
    await prisma.vehicle.create({ data: vehicleData(PLATE) });

    let code: string | null = null;
    try {
      await prisma.vehicle.create({ data: vehicleData(PLATE) });
    } catch (error) {
      code = prismaCode(error);
    }
    expect(code).toBe('P2002');
    expect(await prisma.vehicle.count({ where: { plateNumber: PLATE } })).toBe(
      1,
    );

    // Case and spacing variants are distinct rows at this layer: the API
    // normalises plates (trim, collapse whitespace, upper-case) before storing.
    await expect(
      prisma.vehicle.create({ data: vehicleData(PLATE.toLowerCase()) }),
    ).resolves.toMatchObject({ plateNumber: PLATE.toLowerCase() });
  });

  it('I. explicit lifecycle values and nullable fields persist', async () => {
    const driver = await prisma.driver.create({
      data: driverData('one', { status: 'INACTIVE', notes: 'synthetic note' }),
    });
    expect(driver.status).toBe('INACTIVE');
    expect(driver.notes).toBe('synthetic note');

    const vehicle = await prisma.vehicle.create({
      data: vehicleData(`${PLATE_PREFIX}0002`, {
        status: 'IN_MAINTENANCE',
        currentOdometer: 125_000,
      }),
    });
    expect(vehicle.status).toBe('IN_MAINTENANCE');
    expect(vehicle.currentOdometer).toBe(125_000);

    const retired = await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { status: 'RETIRED' },
    });
    expect(retired.status).toBe('RETIRED');
  });
});
