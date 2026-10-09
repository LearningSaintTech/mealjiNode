// Load-test environment. Imported before anything else (node --import), it
// points every load script and the load API at a SEPARATE database and Redis
// namespace, so the demo data used by the app developers is never touched.
// Nothing can leave the machine: SMS and Google Maps are switched off.
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const parsed = dotenv.config({ path: path.join(root, ".env"), quiet: true }).parsed || {};
const baseUri = process.env.LOAD_MONGO_URI || process.env.MONGO_URI || parsed.MONGO_URI || "mongodb://127.0.0.1:27017/mealji";

const loadUri = process.env.LOAD_MONGO_URI || baseUri.replace(/\/([^/?]*)(\?|$)/, "/mealji_load$2");
const dbName = new URL(loadUri.replace(/^mongodb(\+srv)?:/, "http:")).pathname.slice(1);
if (!dbName.endsWith("_load")) {
  console.error(`Refusing to run load tests against database "${dbName}": its name must end with _load.`);
  process.exit(1);
}

Object.assign(process.env, {
  MONGO_URI: loadUri,
  PORT: process.env.LOAD_PORT || "4100",
  REDIS_KEY_PREFIX: "mealji-load:",
  // No real messages or paid map calls during load runs.
  TWOFACTOR_API_KEY: "",
  TWOFACTOR_BASE_URL: "http://127.0.0.1:9",
  GOOGLE_MAPS_API_KEY: "",
  // Local file storage: the load seed uses the hosted demo images, no S3 writes.
  STORAGE_DRIVER: "local",
  LOG_LEVEL: process.env.LOAD_LOG_LEVEL || "warn",
  LOG_PRETTY: "false",
  // Every virtual user comes from this one machine; real users have their own IPs.
  OTP_IP_SOFT_LIMIT: "100000000",
});
