const { defineFunction } = require("@aws-amplify/backend");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  runtime: 18,
  entry: "./index.js",
});
