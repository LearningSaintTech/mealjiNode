import express, { Router } from "express";
import { body } from "express-validator";
import { asyncHandler } from "../../common/asyncHandler.js";
import { AppError } from "../../common/errors/AppError.js";
import { ok } from "../../common/http.js";
import { authMiddleware } from "../../common/middleware/auth.middleware.js";
import { validate } from "../../common/middleware/validate.js";
import { presignUpload, storeLocalUpload, UPLOAD_PURPOSES } from "./upload.service.js";

const router = Router();

// The local driver's PUT target (development). Signed by the presign call.
router.put(
  "/local/*",
  express.raw({ type: () => true, limit: "10mb" }),
  asyncHandler(async (req, res) => {
    const data = await storeLocalUpload({
      key: req.params[0],
      contentType: String(req.headers["content-type"] || ""),
      expires: req.query.expires,
      providedToken: String(req.query.token || ""),
      body: req.body,
    });
    return ok(res, data, "Uploaded.");
  }),
);

// This router is mounted before the app-wide JSON parser (for the raw PUT above).
router.post(
  "/presign",
  express.json({ limit: "16kb" }),
  authMiddleware,
  body("purpose").isIn(Object.keys(UPLOAD_PURPOSES)).withMessage("Unknown upload purpose"),
  body("contentType").isString().isLength({ max: 60 }),
  body("size").isInt({ min: 1 }).toInt(),
  validate,
  asyncHandler(async (req, res) => {
    // Menu, content and banner uploads are for staff consoles only.
    const staffOnly = ["dish", "banner", "kitchen", "content", "import"];
    if (staffOnly.includes(req.body.purpose) && req.auth.role === "user") throw new AppError(403, "This upload is for staff only");
    return ok(res, presignUpload({ ...req.body, ownerId: req.auth.userId }), "Upload URL created.", 201);
  }),
);

export default router;
