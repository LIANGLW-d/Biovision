import { defineBackend } from "@aws-amplify/backend";
import { Duration } from "aws-cdk-lib";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { beaverApi } from "./functions/beaver-api/resource.js";

const backend = defineBackend({
  beaverApi,
});

const stack = backend.createStack("beaver-jobs-queue");
const queue = new Queue(stack, "BeaverJobsQueue", {
  visibilityTimeout: Duration.minutes(15),
});

backend.beaverApi.resources.lambda.addEnvironment("BEAVER_JOB_QUEUE_URL", queue.queueUrl);
backend.beaverApi.resources.lambda.addEventSource(
  new SqsEventSource(queue, {
    batchSize: 1,
    maxBatchingWindow: Duration.seconds(0),
  }),
);
queue.grantConsumeMessages(backend.beaverApi.resources.lambda);
queue.grantSendMessages(backend.beaverApi.resources.lambda);
