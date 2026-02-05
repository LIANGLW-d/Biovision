const { defineFunction } = require("@aws-amplify/backend");
const path = require("node:path");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  runtime: 18,
  entry: "./index.js",
  depsLockFilePath: path.resolve(
    __dirname,
    "../../..",
    "amplify/functions/beaver-api/package-lock.json",
  ),
});
