import { sendSuccess } from "../../common/responses/apiResponse.js";
import { recordAudit } from "../audit/audit.service.js";
import { toPublicUser } from "../user/user.mapper.js";
import { userRepository } from "../user/user.repository.js";
import * as kitchenService from "./kitchen.service.js";

const KITCHEN_FIELDS = ["name", "contactName", "phoneNumber", "addressLine", "area", "city", "state", "postalCode", "latitude", "longitude", "serviceRadiusKm", "opensAt", "closesAt", "serviceNote", "status", "acceptingOrders"];

function kitchenSnapshot(kitchen) {
  return kitchen ? Object.fromEntries(KITCHEN_FIELDS.map((key) => [key, kitchen[key] ?? null])) : null;
}

export async function searchPlacesController(req, res) {
  const data = await kitchenService.searchKitchenPlaces(req.query.q);
  return sendSuccess(res, { message: "Places fetched.", data });
}

export async function onboardKitchenController(req, res) {
  const data = await kitchenService.onboardKitchen(req.body);
  await recordAudit(req, {
    action: "kitchen.onboarded",
    entityType: "kitchen",
    entityId: data.kitchenId,
    kitchenId: data.kitchenId,
    summary: `Onboarded ${data.name}`,
    after: kitchenSnapshot(data),
    diff: false,
  });
  return sendSuccess(res, {
    status: 201,
    message: "Kitchen onboarded. They can sign in with OTP.",
    data,
  });
}

export async function listKitchensController(req, res) {
  const data = await kitchenService.listKitchens(req.query);
  return sendSuccess(res, { message: "Kitchens fetched successfully.", data });
}

export async function getKitchenController(req, res) {
  const data = await kitchenService.getKitchen(req.params.kitchenId);
  return sendSuccess(res, { message: "Kitchen fetched successfully.", data });
}

export async function updateKitchenController(req, res) {
  const previous = await kitchenService.getKitchen(req.params.kitchenId);
  const data = await kitchenService.updateKitchen(req.params.kitchenId, req.body);
  await recordAudit(req, {
    action: "kitchen.updated",
    entityType: "kitchen",
    entityId: data.kitchenId,
    kitchenId: data.kitchenId,
    summary: `Updated ${data.name}`,
    before: kitchenSnapshot(previous),
    after: kitchenSnapshot(data),
  });
  return sendSuccess(res, { message: "Kitchen configuration updated.", data });
}

export async function updateKitchenStatusController(req, res) {
  const previous = await kitchenService.getKitchen(req.params.kitchenId);
  const data = await kitchenService.setKitchenStatus(req.params.kitchenId, req.body.status);
  if (previous.status !== data.status) await recordAudit(req, {
    action: "kitchen.status_changed",
    entityType: "kitchen",
    entityId: data.kitchenId,
    kitchenId: data.kitchenId,
    summary: `${data.name}: ${previous.status} to ${data.status}`,
    before: { status: previous.status, acceptingOrders: previous.acceptingOrders },
    after: { status: data.status, acceptingOrders: data.acceptingOrders },
  });
  return sendSuccess(res, { message: "Kitchen status updated.", data });
}

export async function ownKitchenController(req, res) {
  const data = await kitchenService.getOwnKitchen(req.auth.userId);
  return sendSuccess(res, { message: "Kitchen fetched successfully.", data });
}

export async function updateServiceController(req, res) {
  const previous = await kitchenService.getOwnKitchen(req.auth.userId);
  const data = await kitchenService.setAcceptingOrders(req.auth.userId, req.body.acceptingOrders);
  if (previous.acceptingOrders !== data.acceptingOrders) await recordAudit(req, {
    action: data.acceptingOrders ? "kitchen.orders_opened" : "kitchen.orders_closed",
    entityType: "kitchen",
    entityId: data.kitchenId,
    kitchenId: data.kitchenId,
    summary: `${data.name} ${data.acceptingOrders ? "started" : "stopped"} taking orders`,
    before: { acceptingOrders: !data.acceptingOrders },
    after: { acceptingOrders: data.acceptingOrders },
  });
  return sendSuccess(res, { message: "Kitchen service updated.", data });
}

export async function configureOwnKitchenController(req, res) {
  const previous = await kitchenService.getOwnKitchen(req.auth.userId);
  const data = await kitchenService.configureOwnKitchen(req.auth.userId, req.body);
  await recordAudit(req, {
    action: "kitchen.updated",
    entityType: "kitchen",
    entityId: data.kitchenId,
    kitchenId: data.kitchenId,
    summary: `Kitchen admin updated ${data.name}`,
    before: kitchenSnapshot(previous),
    after: kitchenSnapshot(data),
  });
  return sendSuccess(res, { message: "Kitchen configuration updated.", data });
}

export async function listKitchenTeamController(req, res) {
  const data = await kitchenService.listKitchenTeam(req.auth.userId);
  return sendSuccess(res, { message: "Kitchen team fetched.", data });
}

export async function inviteKitchenStaffController(req, res) {
  const data = await kitchenService.inviteKitchenSubadmin(req.auth.userId, req.body);
  await recordAudit(req, {
    action: "kitchen.staff_invited",
    entityType: "user",
    entityId: data.userId,
    kitchenId: data.kitchenId,
    summary: `Invited ${data.name} as kitchen subadmin`,
    after: { name: data.name, phoneNumber: data.phoneNumber, role: data.role },
    diff: false,
  });
  return sendSuccess(res, {
    status: 201,
    message: "Kitchen subadmin invited. They can sign in with OTP.",
    data,
  });
}

export async function updateKitchenStaffStatusController(req, res) {
  const target = await userRepository.findById(req.params.userId);
  const previous = target ? toPublicUser(target) : null;
  const data = await kitchenService.updateKitchenSubadminStatus({
    actorUserId: req.auth.userId,
    userId: req.params.userId,
    isActive: req.body.isActive,
  });
  if (previous && previous.isSuspended !== data.isSuspended) {
    await recordAudit(req, {
      action: data.isSuspended ? "kitchen.staff_suspended" : "kitchen.staff_activated",
      entityType: "user",
      entityId: data.userId,
      kitchenId: data.kitchenId,
      summary: `${data.isSuspended ? "Suspended" : "Activated"} ${data.name}`,
      before: { isSuspended: previous.isSuspended, isActive: previous.isActive },
      after: { isSuspended: data.isSuspended, isActive: data.isActive },
    });
  }
  return sendSuccess(res, { message: "Kitchen subadmin status updated.", data });
}
