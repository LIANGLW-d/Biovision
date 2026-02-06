const { defineFunction, secret } = require("@aws-amplify/backend");

exports.beaverApi = defineFunction({
  name: "beaver-api",
  runtime: 18,
  entry: "./handler.mjs",
  timeoutSeconds: 30,
  memoryMB: 2048,
  bundling: {
    externalModules: [],
    nodeModules: ["@aws-sdk/client-ssm", "@aws-sdk/client-sqs"],
  },
  layers: {
    sharp: "arn:aws:lambda:us-east-2:727117753557:layer:sharp-linux-x64:3",
    ssm: "arn:aws:lambda:us-east-2:727117753557:layer:aws-sdk-client-ssm:1",
  },
  depsLockFilePath: "amplify/functions/beaver-api/package-lock.json",
  environment: {
    BEAVER_BEDROCK_MODEL_ID: secret("BEAVER_BEDROCK_MODEL_ID"),
    BEAVER_ANIMAL_MODEL_ID: secret("BEAVER_ANIMAL_MODEL_ID"),
    BEAVER_CHAT_MODEL_ID: secret("BEAVER_CHAT_MODEL_ID"),
    BEAVER_JOB_BUCKET: secret("BEAVER_JOB_BUCKET"),
    BEAVER_DB_URL: secret("BEAVER_DB_URL"),
    BEAVER_DB_SSL: secret("BEAVER_DB_SSL"),
    NODE_PATH: "/opt/nodejs/node_modules:/opt/nodejs/node18/node_modules:/opt/nodejs/nodejs/node_modules",
  },
});
