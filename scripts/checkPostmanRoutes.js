process.env.LOG_PRETTY = "false";

const { readFile } = await import("node:fs/promises");
const path = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { collectPostman, mountedRoutes } = await import("./routeList.js");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectionPath = path.join(rootDir, "postman", "mealJiNode.postman_collection.json");

const expressRoutes = [...(await mountedRoutes()).keys()].sort();
const collection = JSON.parse(await readFile(collectionPath, "utf8"));
const postmanRoutes = [...new Set(collectPostman(collection.item))].sort();

const missingInPostman = expressRoutes.filter((route) => !postmanRoutes.includes(route));
const extraInPostman = postmanRoutes.filter((route) => !expressRoutes.includes(route));

if (missingInPostman.length || extraInPostman.length) {
  console.error("Postman collection is out of sync with mounted routes. Run `npm run postman:sync`.");
  if (missingInPostman.length) {
    console.error("Missing from Postman:");
    for (const route of missingInPostman) console.error(`  ${route}`);
  }
  if (extraInPostman.length) {
    console.error("Present in Postman but not mounted:");
    for (const route of extraInPostman) console.error(`  ${route}`);
  }
  process.exit(1);
}

console.log(`Postman collection matches ${expressRoutes.length} routes.`);
process.exit(0);
