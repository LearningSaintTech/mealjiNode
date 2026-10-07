import { Router } from "express";
import { body, param } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { authFor, idParam, ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { authorize } from "../../common/middleware/authorize.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { recordAudit } from "../audit/audit.service.js";
import * as experiments from "./experiment.service.js";

const customer = Router();
customer.use(authFor(["/experiments"], authMiddleware));
customer.get("/experiments/me", asyncHandler(async (req, res) => ok(res, await experiments.experimentsFor(req.auth.userId), "Experiments.")));

const admin = Router();
admin.use(authFor(["/experiments"], authMiddleware));
admin.get("/experiments", authorize("experiments.manage"), asyncHandler(async (req, res) => ok(res, (await experiments.Experiment.find().sort({ createdAt: -1 }).lean()).map(experiments.toExperiment), "Experiments.")));
admin.post("/experiments", authorize("experiments.manage"), body("key").matches(/^[a-z0-9_]{3,40}$/), validate, asyncHandler(async (req, res) => {
  const data = await experiments.saveExperiment(null, req.body);
  await recordAudit(req, { action: "experiment.created", entityType: "experiment", entityId: data.experimentId, summary: `Created experiment ${data.key}`, diff: false });
  return ok(res, data, "Experiment created.", 201);
}));
admin.patch("/experiments/:id", authorize("experiments.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await experiments.saveExperiment(req.params.id, req.body), "Experiment saved.")));
admin.post("/experiments/:id/:action", authorize("experiments.manage"), idParam(), param("action").isIn(["start", "stop"]), body("winner").optional({ values: "null" }).isString(), validate, asyncHandler(async (req, res) => {
  const data = await experiments.setStatus(req.params.id, { status: req.params.action === "start" ? "running" : "stopped", winner: req.body.winner || null });
  await recordAudit(req, { action: `experiment.${req.params.action}`, entityType: "experiment", entityId: data.experimentId, summary: `${data.key} ${req.params.action === "start" ? "started" : `stopped${data.winner ? `, winner ${data.winner}` : ""}`}`, diff: false });
  return ok(res, data, "Experiment updated.");
}));
admin.delete("/experiments/:id", authorize("experiments.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await experiments.deleteExperiment(req.params.id), "Experiment deleted.")));
admin.get("/experiments/:id/results", authorize("experiments.manage"), idParam(), validate, asyncHandler(async (req, res) => ok(res, await experiments.results(req.params.id), "Results.")));

export function mount(app, recordMountPath) {
  app.use("/api/v1", recordMountPath, customer);
  app.use("/api/v1/admin", recordMountPath, admin);
}
