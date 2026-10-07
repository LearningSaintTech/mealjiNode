import crypto from "node:crypto";
import { env } from "../config/env.js";

// Minimal AWS Signature Version 4 (no SDK): pre-signed S3 URLs and signed JSON
// requests (SES v2). Credentials come from the environment.

const hmac = (key, value) => crypto.createHmac("sha256", key).update(value).digest();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function stamps(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(dateStamp, region, service) {
  const kDate = hmac(`AWS4${env.awsSecretAccessKey}`, dateStamp);
  return hmac(hmac(hmac(kDate, region), service), "aws4_request");
}

const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** A pre-signed PUT URL for one S3 object. The uploader must send the same Content-Type. */
export function presignS3Put({ key, contentType, expiresSec = 600 }) {
  const region = env.s3Region;
  const host = `${env.s3Bucket}.s3.${region}.amazonaws.com`;
  const { amzDate, dateStamp } = stamps();
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const path = `/${key.split("/").map(encode).join("/")}`;
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${env.awsAccessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": "content-type;host",
  };
  const query = Object.keys(params).sort().map((name) => `${encode(name)}=${encode(params[name])}`).join("&");
  const canonical = ["PUT", path, query, `content-type:${contentType}\nhost:${host}\n`, "content-type;host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(dateStamp, region, "s3")).update(toSign).digest("hex");
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

/** Headers for a signed JSON POST to an AWS service endpoint (e.g. SES v2). */
export function signedJsonHeaders({ service, region, host, path, body }) {
  const { amzDate, dateStamp } = stamps();
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const payloadHash = sha256(body);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-date";
  const canonical = ["POST", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const signature = crypto.createHmac("sha256", signingKey(dateStamp, region, service)).update(toSign).digest("hex");
  return {
    "Content-Type": "application/json",
    "X-Amz-Date": amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${env.awsAccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
