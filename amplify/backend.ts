import { defineBackend } from "@aws-amplify/backend";
import { beaverApi } from "./functions/beaver-api/resource.js";

defineBackend({
  beaverApi,
});
