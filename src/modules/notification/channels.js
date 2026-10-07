import crypto from "node:crypto";
import axios from "axios";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { signedJsonHeaders } from "../../infrastructure/awsSigV4.js";

/**
 * Channel adapters. Each `send` returns { ok, providerMessageId?, error?, permanent? }.
 * A channel that is not configured logs the message in development (so flows
 * can be tested) and fails in production.
 */

const http = axios.create({ timeout: 10000 });

function notConfigured(channel, message) {
  if (env.isProd) return { ok: false, error: `${channel} is not configured`, permanent: true };
  logger.info({ channel, to: message.to, title: message.title, body: message.body }, "Message (channel not configured – logged only)");
  return { ok: true, providerMessageId: `dev-${channel}-${crypto.randomBytes(5).toString("hex")}` };
}

// ---- Push (FCM HTTP v1 with a service-account OAuth token)

let fcmToken = null;
let fcmTokenExpiresAt = 0;

async function fcmAccessToken() {
  if (fcmToken && Date.now() < fcmTokenExpiresAt - 60_000) return fcmToken;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: env.fcmClientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");
  const signature = crypto.createSign("RSA-SHA256").update(`${header}.${claims}`).sign(env.fcmPrivateKey).toString("base64url");
  const response = await http.post("https://oauth2.googleapis.com/token", new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${header}.${claims}.${signature}`,
  }));
  fcmToken = response.data.access_token;
  fcmTokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  return fcmToken;
}

export async function sendPush({ token, title, body, imageUrl = null, data = {} }) {
  if (!env.fcmProjectId || !env.fcmClientEmail || !env.fcmPrivateKey) return notConfigured("push", { to: token?.slice(0, 12), title, body });
  try {
    const accessToken = await fcmAccessToken();
    const response = await http.post(
      `https://fcm.googleapis.com/v1/projects/${env.fcmProjectId}/messages:send`,
      {
        message: {
          token,
          notification: { title, body, ...(imageUrl ? { image: imageUrl } : {}) },
          data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value ?? "")])),
          android: { priority: "high" },
          apns: { payload: { aps: { sound: "default" } } },
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    return { ok: true, providerMessageId: response.data.name };
  } catch (error) {
    const code = error?.response?.data?.error?.details?.[0]?.errorCode || error?.response?.data?.error?.status;
    const permanent = ["UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"].includes(code);
    return { ok: false, error: code || error.message, permanent, invalidToken: permanent };
  }
}

// ---- WhatsApp (Meta Cloud API, approved templates only)

export async function sendWhatsapp({ phone, templateName, language = "en", variables = [] }) {
  if (!env.whatsappToken || !env.whatsappPhoneNumberId) return notConfigured("whatsapp", { to: phone, title: templateName, body: variables.join(" | ") });
  try {
    const response = await http.post(
      `https://graph.facebook.com/v20.0/${env.whatsappPhoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: `91${phone}`,
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
          components: variables.length ? [{ type: "body", parameters: variables.map((text) => ({ type: "text", text: String(text).slice(0, 1000) })) }] : [],
        },
      },
      { headers: { Authorization: `Bearer ${env.whatsappToken}` } },
    );
    return { ok: true, providerMessageId: response.data?.messages?.[0]?.id || null };
  } catch (error) {
    const code = error?.response?.data?.error?.code;
    return { ok: false, error: error?.response?.data?.error?.message || error.message, permanent: [131026, 131047, 132001].includes(code) };
  }
}

// ---- SMS (2Factor transactional / DLT)

export async function sendSms({ phone, text, dltTemplateId = null, senderId = null }) {
  if (!env.twoFactorApiKey) return notConfigured("sms", { to: phone, title: "SMS", body: text });
  try {
    const params = new URLSearchParams({ module: "TRANS_SMS", apikey: env.twoFactorApiKey, to: phone, from: senderId || env.smsSenderId, msg: text });
    if (dltTemplateId) params.set("templateid", dltTemplateId);
    const response = await http.get(`${env.twoFactorBaseUrl}/API/R1/?${params}`);
    if (response.data?.Status === "Success") return { ok: true, providerMessageId: response.data.Details || null };
    return { ok: false, error: response.data?.Details || "SMS rejected" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// ---- Email (Amazon SES v2)

export async function sendEmail({ to, subject, html, text, fromName = null, unsubscribeUrl = null }) {
  if (!env.awsAccessKeyId || !env.awsSecretAccessKey) return notConfigured("email", { to, title: subject, body: text });
  const host = `email.${env.sesRegion}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const from = fromName ? `${fromName} <${env.emailFrom.replace(/^.*<|>$/g, "")}>` : env.emailFrom;
  const payload = {
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    Content: { Simple: { Subject: { Data: subject }, Body: { Html: { Data: html || text || "" }, Text: { Data: text || "" } }, ...(unsubscribeUrl ? { Headers: [{ Name: "List-Unsubscribe", Value: `<${unsubscribeUrl}>` }, { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }] } : {}) } },
  };
  const body = JSON.stringify(payload);
  try {
    const response = await http.post(`https://${host}${path}`, body, { headers: signedJsonHeaders({ service: "ses", region: env.sesRegion, host, path, body }) });
    return { ok: true, providerMessageId: response.data?.MessageId || null };
  } catch (error) {
    return { ok: false, error: error?.response?.data?.message || error.message };
  }
}

export function channelStatus() {
  return {
    push: Boolean(env.fcmProjectId && env.fcmClientEmail && env.fcmPrivateKey),
    whatsapp: Boolean(env.whatsappToken && env.whatsappPhoneNumberId),
    sms: Boolean(env.twoFactorApiKey),
    email: Boolean(env.awsAccessKeyId && env.awsSecretAccessKey),
    inapp: true,
  };
}
