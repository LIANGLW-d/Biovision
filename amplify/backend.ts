import { defineBackend } from "@aws-amplify/backend";
// @ts-ignore - Amplify generates JS function resources without TS typings.
import { beaverApi } from "./functions/beaver-api/resource";

defineBackend({
  beaverApi,
});
