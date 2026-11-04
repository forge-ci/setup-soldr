import fs from "node:fs";
import path from "node:path";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function parseJson(name) {
  try {
    return JSON.parse(required(name));
  } catch (error) {
    throw new Error(`${name} must contain valid JSON: ${error.message}`, { cause: error });
  }
}

const capabilities = parseJson("CAPABILITIES_JSON");
const operations = capabilities.supportedOperations;
if (!Array.isArray(operations)) {
  throw new Error("CAPABILITIES_JSON must contain supportedOperations");
}

const argumentsList = parseJson("ARGUMENTS_JSON");
const artifactPaths = parseJson("ARTIFACT_PATHS_JSON");
if (!Array.isArray(argumentsList) || !argumentsList.every((value) => typeof value === "string")) {
  throw new Error("ARGUMENTS_JSON must contain an array of strings");
}
if (!Array.isArray(artifactPaths) || !artifactPaths.every((value) => typeof value === "string")) {
  throw new Error("ARTIFACT_PATHS_JSON must contain an array of strings");
}

const cacheValue = required("CACHE_ENABLED").toLowerCase();
if (cacheValue !== "true" && cacheValue !== "false") {
  throw new Error("CACHE_ENABLED must be true or false");
}

const metadata = {
  schema_version: 1,
  repository: required("REPOSITORY"),
  commit_sha: required("COMMIT_SHA"),
  ref: required("GIT_REF"),
  target: required("TARGET"),
  soldr_version: required("SOLDR_VERSION"),
  target_cache_identity: required("TARGET_CACHE_IDENTITY"),
  operations,
  arguments: argumentsList,
  cache_enabled: cacheValue === "true",
  cache_contract: parseJson("CACHE_CONTRACT_JSON"),
  artifact_paths: artifactPaths,
};

const outputPath = path.resolve(required("METADATA_PATH"));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
console.log(`Wrote release metadata to ${outputPath}`);
