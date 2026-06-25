import { recommendActions } from "../game/recommend";
import type { RecommendationInput } from "../game/types";

self.onmessage = (event: MessageEvent<RecommendationInput>) => {
  try {
    const recommendations = recommendActions(event.data);
    self.postMessage({
      type: "success",
      recommendations
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  }
};
