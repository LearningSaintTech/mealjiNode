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
    // A suspended account is told why (403), instead of being silently signed out.
    if (user && user.isActive && isSuspended(user)) {
      throw new AppError(403, "Your account is suspended. Please contact support.", [{ field: "account", message: "ACCOUNT_SUSPENDED" }]);
    }
    if (!user || !user.isActive || !user.isNumberVerified || tokenRevoked(user, payload.iat)) {
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
