const { defineFunction } = require("@aws-amplify/backend");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  entry: "./index.js",
});
