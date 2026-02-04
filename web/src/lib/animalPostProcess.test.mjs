import assert from "node:assert/strict";
import { postProcessAnimalOutput } from "./animalPostProcess.js";

const lowConfidence = postProcessAnimalOutput({
  common_name: "Beaver",
  confidence: 0.69,
  group: "mammal",
  notes: "",
});
assert.equal(lowConfidence.Common_Name, "unknown");
assert.equal(lowConfidence.manual_review, true);

const unknownCase = postProcessAnimalOutput({
  common_name: "unknown",
  confidence: 0.9,
  group: "unknown",
  notes: "",
});
assert.equal(unknownCase.Common_Name, "unknown");
assert.equal(unknownCase.manual_review, true);

const notInList = postProcessAnimalOutput({
  common_name: "Snowshoe hare",
  confidence: 0.9,
  group: "mammal",
  notes: "",
});
assert.equal(notInList.Common_Name, "other mammal");
assert.equal(notInList.manual_review, false);

const noAnimal = postProcessAnimalOutput({
  common_name: "No animal",
  confidence: 0.9,
  group: "none",
  notes: "",
});
assert.equal(noAnimal.Common_Name, "No animal");
assert.equal(noAnimal.manual_review, false);

console.log("animalPostProcess tests passed");
