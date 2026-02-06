const { defineFunction, secret } = require("@aws-amplify/backend");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  runtime: 18,
  entry: "./handler.mjs",
  timeoutSeconds: 30,
  memoryMB: 1024,
  layers: ["arn:aws:lambda:us-east-2:145266761615:layer:sharp:10"],
  depsLockFilePath: "package-lock.json",
  environment: {
    BEAVER_BEDROCK_MODEL_ID: secret("BEAVER_BEDROCK_MODEL_ID"),
    BEAVER_ANIMAL_MODEL_ID: secret("BEAVER_ANIMAL_MODEL_ID"),
    BEAVER_CHAT_MODEL_ID: secret("BEAVER_CHAT_MODEL_ID"),
    BEAVER_JOB_BUCKET: secret("BEAVER_JOB_BUCKET"),
    BEAVER_DB_URL: secret("BEAVER_DB_URL"),
    BEAVER_DB_SSL: secret("BEAVER_DB_SSL"),
  },
});
