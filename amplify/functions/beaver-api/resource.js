const { defineFunction, secret } = require("@aws-amplify/backend");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  runtime: 18,
  entry: "./index.js",
  depsLockFilePath: "package-lock.json",
  environment: {
    AWS_REGION: secret("AWS_REGION"),
    BEAVER_BEDROCK_MODEL_ID: secret("BEAVER_BEDROCK_MODEL_ID"),
    BEAVER_ANIMAL_MODEL_ID: secret("BEAVER_ANIMAL_MODEL_ID"),
    BEAVER_CHAT_MODEL_ID: secret("BEAVER_CHAT_MODEL_ID"),
    BEAVER_JOB_BUCKET: secret("BEAVER_JOB_BUCKET"),
    BEAVER_DB_URL: secret("BEAVER_DB_URL"),
    BEAVER_DB_SSL: secret("BEAVER_DB_SSL"),
  },
});
