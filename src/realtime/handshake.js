/**
 * WebSocket handshake helpers (pure, for tests). The app sends its access token
 * as the subprotocol (`new WebSocket(url, [token])`) so it stays out of proxy
 * logs; older app versions use ?token=. A browser or React Native only accepts
 * the handshake when the server answers with one of the offered subprotocols.
 */

const looksLikeJwt = (value) => value.split(".").length === 3;

export function offeredProtocols(header) {
  return String(header || "").split(",").map((part) => part.trim()).filter(Boolean);
}

/** The access token: the JWT-shaped subprotocol first, then ?token=. */
export function handshakeToken(headers, url) {
  return offeredProtocols(headers?.["sec-websocket-protocol"]).find(looksLikeJwt) || url.searchParams.get("token") || null;
}

/**
 * The subprotocol to answer with: a named one when the client offers it (so the
 * token is not echoed back), otherwise the token itself. false = none offered.
 */
export function selectProtocol(protocols) {
  const list = [...protocols];
  return list.find((value) => !looksLikeJwt(value)) || list[0] || false;
}
