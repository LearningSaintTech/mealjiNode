import { sendSuccess } from "../../common/responses/apiResponse.js";
import { listAuditLogs } from "./audit.service.js";

export async function listAuditLogsController(req, res) {
  const data = await listAuditLogs(req.query);
  return sendSuccess(res, { message: "Audit log fetched.", data });
}
