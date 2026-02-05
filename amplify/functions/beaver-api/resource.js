const { defineFunction } = require("@aws-amplify/backend");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  runtime: 18,
  entry: "amplify/functions/beaver-api/index.js",
  depsLockFilePath: "amplify/functions/beaver-api/package-lock.json",
});
