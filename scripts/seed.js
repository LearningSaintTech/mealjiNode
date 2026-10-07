import { assertRuntimeEnv, env } from "../src/config/env.js";
import { logger } from "../src/config/logger.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { maskPhone, normalizeMobile } from "../src/common/phone.util.js";
import { LOCKED_GRANTS, PERMISSIONS, ROLE_GRANTS, ROLE_META } from "../src/constants/permissions.js";
import { permissionRepository } from "../src/modules/permission/permission.repository.js";
import { roleRepository } from "../src/modules/role/role.repository.js";
import { Role } from "../src/modules/role/role.model.js";
import mongoose from "mongoose";
import { User } from "../src/modules/user/user.model.js";
import { userRepository } from "../src/modules/user/user.repository.js";
import { kitchenRepository } from "../src/modules/kitchen/kitchen.repository.js";
import { geocodeAddress } from "../src/infrastructure/googleMaps.service.js";
import { inviteKitchenSubadmin, onboardKitchen } from "../src/modules/kitchen/kitchen.service.js";
import { seedDemoData } from "./seedDemo.js";

// `npm run seed -- --fresh` clears test data (backed up to .seed-backups/) before
// building the demo data again. `--no-demo-data` seeds only roles and accounts.
const FRESH = process.argv.includes("--fresh");
const DEMO_DATA = !process.argv.includes("--no-demo-data");

async function retireRole(fromSlug, toSlug) {
  const previous = await roleRepository.findBySlug(fromSlug);
  if (!previous) return;
  const next = await roleRepository.findBySlug(toSlug);
  if (next) {
    await User.updateMany({ role: previous._id }, { $set: { role: next._id } });
  }
  const remaining = await User.countDocuments({ role: previous._id });
  if (remaining === 0) {
    await Role.deleteOne({ _id: previous._id });
    logger.info({ fromSlug, toSlug }, "Retired previous role");
  }
}

// Remembers, per role, which default permissions have already been offered.
// Roles customised in the console keep their choices; a permission is granted
// to its default roles once (when it first appears), even if an earlier seed
// run stopped half-way.
async function offerNewDefaultGrants(knownKeysBefore) {
  const state = mongoose.connection.db.collection("seedstate");
  const doc = await state.findOne({ _id: "role-grants" });
  const offered = doc?.offered || {};
  const granted = {};
  for (const [slug, grants] of Object.entries(ROLE_GRANTS)) {
    // First run with this tracking: everything that already existed counts as offered.
    const already = new Set(offered[slug] || (doc ? [] : grants.filter((key) => knownKeysBefore.has(key))));
    const fresh = grants.filter((key) => !already.has(key));
    if (fresh.length) {
      const permissions = await permissionRepository.findByKeys(fresh);
      await Role.updateOne({ slug }, { $addToSet: { permissions: { $each: permissions.map((permission) => permission._id) } } });
      granted[slug] = fresh;
    }
    offered[slug] = [...new Set([...already, ...fresh])];
  }
  await state.updateOne({ _id: "role-grants" }, { $set: { offered, updatedAt: new Date() } }, { upsert: true });
  if (Object.keys(granted).length) logger.info({ granted }, "New permissions granted to their default roles");
}

async function seedIdentity() {
  const knownKeys = new Set((await permissionRepository.list()).map((permission) => permission.key));
  for (const permission of PERMISSIONS) {
    await permissionRepository.upsertByKey(permission);
  }

  for (const [slug, meta] of Object.entries(ROLE_META)) {
    const permissions = await permissionRepository.findByKeys(ROLE_GRANTS[slug]);
    const locked = await permissionRepository.findByKeys(LOCKED_GRANTS[slug] || []);
    await roleRepository.upsertSystemRole({
      slug,
      name: meta.name,
      description: meta.description,
      scope: meta.scope,
      permissionIds: permissions.map((permission) => permission._id),
      lockedIds: locked.map((permission) => permission._id),
    });
  }

  await offerNewDefaultGrants(knownKeys);

  logger.info({ roles: Object.keys(ROLE_META), permissions: PERMISSIONS.length }, "Roles and permissions seeded");
  await retireRole("admin", "superadmin");
  await retireRole("kitchen", "kitchen_admin");

  if (!env.seedAdminPhone) {
    logger.info("SEED_ADMIN_PHONE is empty, skipping bootstrap admin");
    return;
  }

  const phone = normalizeMobile(env.seedAdminPhone);
  if (!/^[6-9]\d{9}$/.test(phone)) {
    throw new Error("SEED_ADMIN_PHONE must be an Indian mobile number");
  }
  if (!/^\+\d{1,3}$/.test(env.seedAdminCountryCode)) {
    throw new Error("SEED_ADMIN_COUNTRY_CODE is invalid");
  }

  const adminRole = await roleRepository.findBySlug("superadmin");
  const existing = await userRepository.findByPhone(env.seedAdminCountryCode, phone);

  if (!existing) {
    await userRepository.create({
      name: env.seedAdminName,
      countryCode: env.seedAdminCountryCode,
      phoneNumber: phone,
      role: adminRole._id,
      isActive: false,
      isNumberVerified: false,
    });
    logger.info({ phone: maskPhone(phone) }, "Bootstrap admin created");
    return;
  }

  if (existing.role?.slug !== "superadmin") {
    logger.warn({ phone: maskPhone(phone) }, "SEED_ADMIN_PHONE already belongs to another account; role was not changed");
    return;
  }

  logger.info({ phone: maskPhone(phone) }, "Bootstrap admin already exists");
}

const DEMO_ACCOUNTS = [
  { role: "superadmin", name: "MealJi Super Admin", phone: "9000000001" },
  { role: "subadmin", name: "Platform Subadmin", phone: "9000000002" },
  { role: "user", name: "Rahul Sharma", phone: "9000000031" },
  { role: "user", name: "Priya Nair", phone: "9000000032" },
];

const DEMO_KITCHENS = [
  {
    name: "Koramangala Kitchen",
    contactName: "Anita Rao",
    phoneNumber: "9000000011",
    addressLine: "12 4th Block",
    area: "Koramangala",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560034",
    opensAt: "08:00",
    closesAt: "21:00",
    serviceNote: "Home-style lunches and dinners",
    latitude: 12.9352,
    longitude: 77.6245,
    serviceRadiusKm: 3,
    status: "active",
    acceptingOrders: true,
    subadmins: [{ name: "Ravi Kumar", phone: "9000000012" }],
  },
  {
    name: "Indiranagar Kitchen",
    contactName: "Meera Shah",
    phoneNumber: "9000000021",
    addressLine: "48 100 Feet Road",
    area: "Indiranagar",
    city: "Bengaluru",
    state: "Karnataka",
    postalCode: "560038",
    opensAt: "09:00",
    closesAt: "22:00",
    serviceNote: "Breakfast and evening snacks",
    latitude: 12.9719,
    longitude: 77.6412,
    serviceRadiusKm: 3,
    status: "onboarding",
    acceptingOrders: false,
    subadmins: [{ name: "Kiran Das", phone: "9000000022" }],
  },
];

// Marks a freshly created demo account as signed in. Accounts that already
// signed in (or were suspended since) are left alone on re-runs.
async function activateAccount(userId) {
  const user = await userRepository.findById(userId);
  if (!user || user.isNumberVerified || user.suspendedAt) return;
  await userRepository.updateById(userId, { isActive: true, isNumberVerified: true });
}

async function seedDemo() {
  if (env.isProd) return;

  for (const account of DEMO_ACCOUNTS) {
    const existing = await userRepository.findByPhone("+91", account.phone);
    if (existing) continue;
    const role = await roleRepository.findBySlug(account.role);
    await userRepository.create({
      name: account.name,
      countryCode: "+91",
      phoneNumber: account.phone,
      role: role._id,
      isActive: true,
      isNumberVerified: true,
    });
  }

  for (const kitchen of DEMO_KITCHENS) {
    let record = await kitchenRepository.findByPhone(kitchen.phoneNumber);
    if (!record) {
      const created = await onboardKitchen({ ...kitchen, countryCode: "+91" });
      record = await kitchenRepository.findById(created.kitchenId);
    }
    if (record?.user) await activateAccount(record.user);
    if (kitchen.acceptingOrders && record && !record.acceptingOrders && record.status === "active") {
      record = await kitchenRepository.updateById(record._id, { acceptingOrders: true });
    }
    const zone = {};
    if (record && record.serviceRadiusKm == null) zone.serviceRadiusKm = kitchen.serviceRadiusKm;
    // Only place kitchens that have no pin yet; never move a pin set in the console.
    const needsPin = record && (record.latitude == null || record.longitude == null);
    if (needsPin && env.googleMapsApiKey) {
      try {
        const point = await geocodeAddress([kitchen.addressLine, kitchen.area, kitchen.city, kitchen.state, kitchen.postalCode, "India"].filter(Boolean).join(", "));
        if (point) {
          zone.latitude = point.latitude;
          zone.longitude = point.longitude;
        }
      } catch (error) {
        logger.warn({ err: error.message, kitchen: kitchen.name }, "Google Maps could not place the demo kitchen");
      }
    }
    if (record && zone.latitude == null && (record.latitude == null || record.longitude == null)) {
      zone.latitude = kitchen.latitude;
      zone.longitude = kitchen.longitude;
    }
    if (record && Object.keys(zone).length) {
      record = await kitchenRepository.updateById(record._id, zone);
    }

    if (!record?.user) {
      logger.warn({ kitchen: kitchen.name }, "Demo kitchen has no admin account; skipping its subadmins");
      continue;
    }
    for (const member of kitchen.subadmins) {
      const existing = await userRepository.findByPhone("+91", member.phone);
      if (existing) continue;
      const invited = await inviteKitchenSubadmin(record.user, {
        name: member.name,
        countryCode: "+91",
        phoneNumber: member.phone,
      });
      await activateAccount(invited.userId);
    }
  }

  logger.info({
    superadmin: "9000000001",
    subadmin: "9000000002",
    kitchenAdmins: ["9000000011", "9000000021"],
    kitchenSubadmins: ["9000000012", "9000000022"],
  }, "Demo accounts are ready");
}

try {
  assertRuntimeEnv();
} catch (err) {
  logger.error({ err: err.message }, "Invalid environment");
  process.exit(1);
}

try {
  await connectDatabase();
  await seedIdentity();
  await seedDemo();
  if (DEMO_DATA && !env.isProd) await seedDemoData({ fresh: FRESH });
} catch (err) {
  logger.error({ err }, "Seed failed");
  process.exitCode = 1;
} finally {
  await disconnectDatabase().catch(() => {});
  await new Promise((resolve) => logger.flush(resolve));
  process.exit(process.exitCode || 0);
}
