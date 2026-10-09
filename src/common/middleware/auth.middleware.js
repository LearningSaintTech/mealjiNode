import { AppError } from "../errors/AppError.js";
import { isAccessDenied } from "../../infrastructure/accessTokenDenylist.service.js";
import { verifyAccessToken } from "../../infrastructure/token.service.js";
import { userRepository } from "../../modules/user/user.repository.js";
import { isSuspended, tokenRevoked } from "../../modules/user/user.status.js";

export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) throw new AppError(401, "Authentication required");
    // Several routers guard the same path: check the token once per request.
    if (req.auth && req.auth.token === token) return next();

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(401, "Invalid or expired token");
    }

    if (await isAccessDenied(payload.jti)) {
      throw new AppError(401, "Invalid or expired token");
    }

    const user = await userRepository.findForAuth(payload.userId);
    if (!user || !user.isActive || !user.isNumberVerified || isSuspended(user) || tokenRevoked(user, payload.iat)) {
      throw new AppError(401, "Invalid or expired token");
    }

    req.auth = {
      userId: String(user._id),
      role: user.role?.slug,
      permissions: (user.role?.permissions || []).map((permission) => permission.key),
      jti: payload.jti,
      exp: payload.exp,
      token,
      user,
    };
    next();
  } catch (err) {
    next(err);
  }
}
