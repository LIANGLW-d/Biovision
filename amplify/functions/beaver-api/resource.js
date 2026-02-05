const { defineFunction } = require("@aws-amplify/backend");
const path = require("node:path");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  runtime: 18,
  entry: "./index.js",
  depsLockFilePath: path.join(__dirname, "package-lock.json"),
});
